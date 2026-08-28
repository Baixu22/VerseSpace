import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blackboard } from "../blackboard";

/**
 * The chat runtime: task-agnostic conversation threads owned by the workbench
 * server, backed by a real agent CLI (claude) in stream-json mode.
 *
 * Concurrency model — the product's focus:
 * - each thread serializes its own runs (one in-flight run per thread);
 * - distinct threads run in parallel (independent child processes);
 * - cancel hard-kills the child; thread state stays on disk, so nothing is
 *   lost and the next message simply continues via --resume.
 */

export interface ThreadMeta {
	id: string;
	title: string;
	createdAt: string;
	claudeSessionId?: string;
	status: "idle" | "running";
}

export interface StoredMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	at: string;
}

const CHAT_COMMAND =
	process.env.WORKBENCH_CHAT_COMMAND ??
	"claude -p --verbose --output-format stream-json --include-partial-messages";

export class ChatThreads {
	private meta = new Map<string, ThreadMeta>();
	private queues = new Map<string, Promise<unknown>>();
	private running = new Map<string, ChildProcess>();

	constructor(private bb: Blackboard) {}

	private dir(id: string): string {
		return join(this.bb.paths.root, "threads", id);
	}
	private metaFile(id: string): string {
		return join(this.dir(id), "meta.json");
	}
	private messagesFile(id: string): string {
		return join(this.dir(id), "messages.jsonl");
	}

	async list(): Promise<ThreadMeta[]> {
		const { readdir } = await import("node:fs/promises");
		try {
			const ids = await readdir(join(this.bb.paths.root, "threads"));
			const metas = await Promise.all(
				ids.map((id) => this.get(id).catch(() => null)),
			);
			return metas
				.filter((m): m is ThreadMeta => m !== null)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		} catch {
			return [];
		}
	}

	async create(title?: string): Promise<ThreadMeta> {
		const { newId } = await import("../ids");
		const id = newId("t");
		const meta: ThreadMeta = {
			id,
			title: title?.trim() || "新对话",
			createdAt: new Date().toISOString(),
			status: "idle",
		};
		await mkdir(this.dir(id), { recursive: true });
		await writeFile(this.metaFile(id), JSON.stringify(meta, null, 2), "utf8");
		await writeFile(this.messagesFile(id), "", "utf8");
		this.meta.set(id, meta);
		return meta;
	}

	async get(id: string): Promise<ThreadMeta> {
		const cached = this.meta.get(id);
		if (cached) {
			return cached;
		}
		const meta = JSON.parse(
			await readFile(this.metaFile(id), "utf8"),
		) as ThreadMeta;
		this.meta.set(id, meta);
		return meta;
	}

	async messages(id: string): Promise<StoredMessage[]> {
		const raw = await readFile(this.messagesFile(id), "utf8");
		return raw
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as StoredMessage);
	}

	private async appendMessage(
		id: string,
		message: StoredMessage,
	): Promise<void> {
		const { appendFile } = await import("node:fs/promises");
		await appendFile(
			this.messagesFile(id),
			`${JSON.stringify(message)}\n`,
			"utf8",
		);
	}

	private async saveMeta(meta: ThreadMeta): Promise<void> {
		this.meta.set(meta.id, meta);
		await writeFile(
			this.metaFile(meta.id),
			JSON.stringify(meta, null, 2),
			"utf8",
		);
	}

	/** Per-thread serialization: runs on one thread queue up, threads run in parallel. */
	private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
		const prev = this.queues.get(id) ?? Promise.resolve();
		const next = prev.then(task, task);
		this.queues.set(
			id,
			next.catch(() => {}),
		);
		return next;
	}

	cancel(id: string): void {
		this.running.get(id)?.kill();
	}

	/**
	 * Run one exchange. Streams NDJSON events to `emit`:
	 * {type:"delta",text} → {type:"done",message,claudeSessionId} |
	 * {type:"error",message}. Persists both sides; keeps the claude session id
	 * so follow-ups resume the same conversation.
	 */
	run(
		id: string,
		text: string,
		emit: (event: Record<string, unknown>) => void,
	): Promise<void> {
		return this.enqueue(id, async () => {
			const meta = await this.get(id);
			const userMessage: StoredMessage = {
				id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				role: "user",
				text,
				at: new Date().toISOString(),
			};
			await this.appendMessage(id, userMessage);
			emit({ type: "user", message: userMessage });
			if (meta.title === "新对话") {
				meta.title = text.trim().slice(0, 24) || meta.title;
			}

			meta.status = "running";
			await this.saveMeta(meta);

			const assistantTexts: string[] = [];
			let claudeSessionId = meta.claudeSessionId;

			await new Promise<void>((resolve) => {
				const parts = CHAT_COMMAND.split(" ").filter(Boolean);
				const bin = parts[0]!;
				const args = parts.slice(1);
				if (claudeSessionId) {
					args.push("--resume", claudeSessionId);
				}
				let child: ChildProcess;
				try {
					child = spawn(bin, args, {
						cwd: this.bb.projectRoot,
						// npm-installed claude is a .cmd shim on Windows; shell resolves it
						shell: process.platform === "win32",
					});
				} catch (error) {
					emit({ type: "error", message: `agent 启动失败：${String(error)}` });
					resolve();
					return;
				}
				this.running.set(id, child);

				let buffer = "";
				let stderr = "";
				const handleLine = (line: string) => {
					if (!line.trim()) {
						return;
					}
					let event: Record<string, unknown>;
					try {
						event = JSON.parse(line) as Record<string, unknown>;
					} catch {
						return;
					}
					const sessionId =
						typeof event.session_id === "string" ? event.session_id : undefined;
					if (sessionId) {
						claudeSessionId = sessionId;
					}
					if (event.type === "stream_event") {
						const inner = event.event as
							| { type?: string; delta?: { type?: string; text?: string } }
							| undefined;
						if (
							inner?.type === "content_block_delta" &&
							inner.delta?.type === "text_delta" &&
							inner.delta.text
						) {
							assistantTexts.push(inner.delta.text);
							emit({ type: "delta", text: inner.delta.text });
						}
					} else if (event.type === "result") {
						const result =
							typeof event.result === "string" ? event.result : undefined;
						if (result && assistantTexts.length === 0) {
							assistantTexts.push(result);
							emit({ type: "delta", text: result });
						}
					}
				};

				child.stdout?.on("data", (chunk: Buffer) => {
					buffer += chunk.toString("utf8");
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						handleLine(line);
					}
				});
				child.stderr?.on("data", (chunk: Buffer) => {
					stderr += chunk.toString("utf8");
				});
				// cmd.exe forwards stdin only after it has spawned the child:
				// an immediate write+end can be swallowed, leaving the agent
				// waiting on an empty stdin. Send once the first output chunk
				// proves the pipe is live (500ms fallback).
				let promptSent = false;
				const sendPrompt = () => {
					if (promptSent) {
						return;
					}
					promptSent = true;
					child.stdin?.write(text);
					child.stdin?.end();
				};
				child.stdout?.once("data", sendPrompt);
				const promptTimer = setTimeout(sendPrompt, 500);

				child.on("close", async (code) => {
					clearTimeout(promptTimer);
					this.running.delete(id);
					if (stderr.trim() && assistantTexts.length === 0) {
						emit({ type: "error", message: stderr.trim().slice(0, 500) });
					}
					const full = assistantTexts.join("");
					if (full) {
						const assistantMessage: StoredMessage = {
							id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
							role: "assistant",
							text: full,
							at: new Date().toISOString(),
						};
						await this.appendMessage(id, assistantMessage);
						emit({
							type: "done",
							message: assistantMessage,
							claudeSessionId,
						});
					} else if (code !== 0 && assistantTexts.length === 0) {
						emit({
							type: "error",
							message: `agent 退出码 ${code}${stderr.trim() ? `：${stderr.trim().slice(0, 200)}` : "（无输出）"}`,
						});
					}
					const latest = await this.get(id);
					latest.status = "idle";
					latest.claudeSessionId = claudeSessionId ?? latest.claudeSessionId;
					await this.saveMeta(latest);
					resolve();
				});
				child.on("error", (error) => {
					this.running.delete(id);
					emit({ type: "error", message: `agent 进程错误：${String(error)}` });
					resolve();
				});
			});
		});
	}
}
