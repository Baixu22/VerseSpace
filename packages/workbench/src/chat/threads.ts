import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blackboard } from "../blackboard";
import type { WorkbenchConfig } from "../types/config";

/**
 * The chat runtime: threads owned by the workbench server, backed by a
 * configurable provider — the local claude CLI (stream-json) or HTTP
 * streaming APIs (OpenAI Chat Completions / Responses, Anthropic Messages).
 *
 * Concurrency model — the product's focus:
 * - each thread serializes its own runs (one in-flight run per thread);
 * - distinct threads run in parallel (independent child processes / fetches);
 * - cancel hard-kills the child or aborts the fetch; thread state stays on
 *   disk, so nothing is lost.
 */

export type PermissionMode = "default" | "plan" | "acceptEdits";

export interface ThreadMeta {
	id: string;
	title: string;
	createdAt: string;
	/** Only meaningful for the claude provider (session resume). */
	claudeSessionId?: string;
	status: "idle" | "running";
	/** plan 模式下跑出的最后回复即计划，UI 渲染批准卡 */
	permissionMode: PermissionMode;
}

export type MessagePart =
	| { type: "text"; text: string }
	| {
			type: "tool-call";
			toolCallId: string;
			toolName: string;
			args: unknown;
	  };

export interface StoredMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	at: string;
	/** assistant 消息的结构化内容（text / tool-call）；user 消息省略 */
	parts?: MessagePart[];
}

export type RunEvent = Record<string, unknown>;

const CHAT_COMMAND =
	process.env.WORKBENCH_CHAT_COMMAND ??
	"claude -p --verbose --output-format stream-json --include-partial-messages";

export class ChatThreads {
	private meta = new Map<string, ThreadMeta>();
	private queues = new Map<string, Promise<unknown>>();
	private running = new Map<string, ChildProcess | AbortController>();

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
			permissionMode: "default",
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
		const handle = this.running.get(id);
		if (handle instanceof AbortController) {
			handle.abort();
		} else if (handle) {
			handle.kill();
		}
	}

	/** Patch mutable meta fields (title / permissionMode). */
	async update(
		id: string,
		patch: Partial<Pick<ThreadMeta, "title" | "permissionMode">>,
	): Promise<ThreadMeta> {
		const meta = await this.get(id);
		if (patch.title !== undefined) {
			meta.title = patch.title;
		}
		if (patch.permissionMode !== undefined) {
			meta.permissionMode = patch.permissionMode;
		}
		await this.saveMeta(meta);
		return meta;
	}

	/** Drop the trailing assistant message; returns the user text to resend. */
	async reload(
		id: string,
	): Promise<{ ok: boolean; userText?: string; reason?: string }> {
		return this.enqueue(id, async () => {
			if (this.running.get(id)) {
				return { ok: false, reason: "线程正在运行" };
			}
			const messages = await this.messages(id);
			const last = messages.at(-1);
			if (last?.role !== "assistant") {
				return { ok: false, reason: "最后一条不是助手消息" };
			}
			const kept = messages.slice(0, -1);
			const userText = kept.at(-1)?.text;
			if (!userText) {
				return { ok: false, reason: "找不到对应的用户消息" };
			}
			await writeFile(
				this.messagesFile(id),
				`${kept.map((m) => JSON.stringify(m)).join("\n")}${kept.length ? "\n" : ""}`,
				"utf8",
			);
			// claude resume context diverges after truncation — start fresh
			const meta = await this.get(id);
			meta.claudeSessionId = undefined;
			await this.saveMeta(meta);
			return { ok: true, userText };
		});
	}

	/**
	 * Run one exchange. Streams NDJSON events to `emit`:
	 * {type:"user",message} → {type:"delta",text} → {type:"tool",part} →
	 * {type:"done",message} | {type:"error",message}.
	 * `opts.resend` skips re-appending the user message (reload flow).
	 */
	run(
		id: string,
		text: string,
		emit: (event: RunEvent) => void,
		opts: { resend?: boolean } = {},
	): Promise<void> {
		return this.enqueue(id, async () => {
			const meta = await this.get(id);
			if (!opts.resend) {
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
					await this.saveMeta(meta);
				}
			}

			meta.status = "running";
			await this.saveMeta(meta);

			const config = await this.bb.config.load();
			const chat = config.chat;

			if (chat.provider === "claude") {
				let claudeSessionId: string | undefined = meta.claudeSessionId;
				await new Promise<void>((resolve) => {
					const parts = CHAT_COMMAND.split(" ").filter(Boolean);
					const bin = parts[0]!;
					const args = parts.slice(1);
					if (meta.permissionMode !== "default") {
						args.push("--permission-mode", meta.permissionMode);
					}
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
						emit({
							type: "error",
							message: `agent 启动失败：${String(error)}`,
						});
						resolve();
						return;
					}
					this.running.set(id, child);

					const assistantTexts: string[] = [];
					const messageParts: MessagePart[] = [];
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
							typeof event.session_id === "string"
								? event.session_id
								: undefined;
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
								const last = messageParts.at(-1);
								if (last?.type === "text") {
									last.text += inner.delta.text;
								} else {
									messageParts.push({ type: "text", text: inner.delta.text });
								}
								assistantTexts.push(inner.delta.text);
								emit({ type: "delta", text: inner.delta.text });
							}
						} else if (event.type === "assistant") {
							const message = event.message as
								| { content?: Array<Record<string, unknown>> }
								| undefined;
							for (const block of message?.content ?? []) {
								if (block.type === "tool_use") {
									const part: MessagePart = {
										type: "tool-call",
										toolCallId: String(block.id ?? ""),
										toolName: String(block.name ?? "tool"),
										args: block.input ?? {},
									};
									messageParts.push(part);
									emit({ type: "tool", part });
								}
							}
						} else if (event.type === "result") {
							const result =
								typeof event.result === "string" ? event.result : undefined;
							if (result && assistantTexts.length === 0) {
								assistantTexts.push(result);
								messageParts.push({ type: "text", text: result });
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
					// an immediate write+end can be swallowed. Send once the first
					// output chunk proves the pipe is live (500ms fallback).
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
						if (
							full ||
							messageParts.some((part) => part.type === "tool-call")
						) {
							const assistantMessage: StoredMessage = {
								id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
								role: "assistant",
								text: full,
								at: new Date().toISOString(),
								parts: messageParts,
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
						if (latest.permissionMode === "acceptEdits") {
							latest.permissionMode = "default";
						}
						await this.saveMeta(latest);
						resolve();
					});
					child.on("error", (error) => {
						this.running.delete(id);
						emit({
							type: "error",
							message: `agent 进程错误：${String(error)}`,
						});
						resolve();
					});
				});
				return;
			}

			// ── HTTP providers: OpenAI Chat Completions / Responses, Anthropic ──
			const controller = new AbortController();
			this.running.set(id, controller);
			const messageParts: MessagePart[] = [];
			try {
				await this.runHttp(chat, id, emit, messageParts, controller.signal);
			} catch (error) {
				emit({ type: "error", message: String(error).slice(0, 400) });
			} finally {
				this.running.delete(id);
				const full = messageParts
					.filter((p): p is { type: "text"; text: string } => p.type === "text")
					.map((p) => p.text)
					.join("");
				if (full) {
					const assistantMessage: StoredMessage = {
						id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						role: "assistant",
						text: full,
						at: new Date().toISOString(),
						parts: messageParts,
					};
					await this.appendMessage(id, assistantMessage);
					emit({ type: "done", message: assistantMessage });
				}
				const latest = await this.get(id);
				latest.status = "idle";
				await this.saveMeta(latest);
			}
		});
	}

	/** History for HTTP providers: flat text turns from the stored transcript. */
	private async history(
		id: string,
	): Promise<Array<{ role: string; content: string }>> {
		const messages = await this.messages(id);
		return messages
			.filter((m) => m.text.trim().length > 0)
			.map((m) => ({ role: m.role, content: m.text }));
	}

	private async runHttp(
		chat: WorkbenchConfig["chat"],
		id: string,
		emit: (event: RunEvent) => void,
		messageParts: MessagePart[],
		signal: AbortSignal,
	): Promise<void> {
		const provider = chat.provider;
		const key = chat.apiKey ?? "";
		if (!key && provider !== "claude") {
			emit({
				type: "error",
				message: "未配置 API Key——在 设置 中填写后重试",
			});
			return;
		}

		let url: string;
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		const history = await this.history(id);
		const body: Record<string, unknown> = {};

		if (provider === "anthropic") {
			url = `${(chat.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;
			headers["x-api-key"] = key;
			headers["anthropic-version"] = "2023-06-01";
			body.model = chat.model ?? "claude-sonnet-4-5";
			body.max_tokens = chat.maxTokens ?? 1024;
			if (chat.temperature !== undefined) {
				body.temperature = chat.temperature;
			}
			body.stream = true;
			body.messages = history;
		} else if (provider === "openai-chat") {
			url = `${(chat.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
			headers.authorization = `Bearer ${key}`;
			body.model = chat.model ?? "gpt-4o-mini";
			body.messages = history;
			body.stream = true;
			if (chat.temperature !== undefined) {
				body.temperature = chat.temperature;
			}
			if (chat.maxTokens !== undefined) {
				body.max_tokens = chat.maxTokens;
			}
		} else {
			// openai-responses
			url = `${(chat.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`;
			headers.authorization = `Bearer ${key}`;
			body.model = chat.model ?? "gpt-4o-mini";
			body.input = history.map((m) => ({ role: m.role, content: m.content }));
			body.stream = true;
			if (chat.temperature !== undefined) {
				body.temperature = chat.temperature;
			}
			if (chat.maxTokens !== undefined) {
				body.max_output_tokens = chat.maxTokens;
			}
			if (chat.effort) {
				body.reasoning = { effort: chat.effort };
			}
		}

		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});
		if (!response.ok || !response.body) {
			const detail = (await response.text()).slice(0, 300);
			emit({
				type: "error",
				message: `${provider} HTTP ${response.status}：${detail}`,
			});
			return;
		}

		// unified SSE consumption → text deltas
		const onSseData = (payload: string) => {
			if (payload === "[DONE]") {
				return;
			}
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(payload) as Record<string, unknown>;
			} catch {
				return;
			}
			let delta: string | undefined;
			if (provider === "anthropic") {
				if (event.type === "content_block_delta") {
					const d = event.delta as { type?: string; text?: string } | undefined;
					if (d?.type === "text_delta" && d.text) {
						delta = d.text;
					}
				} else if (event.type === "error") {
					const err = event.error as { message?: string } | undefined;
					emit({
						type: "error",
						message: err?.message ?? "anthropic stream error",
					});
				}
			} else if (provider === "openai-chat") {
				const choices = event.choices as
					| Array<{ delta?: { content?: string } }>
					| undefined;
				delta = choices?.[0]?.delta?.content;
			} else {
				// openai-responses
				if (event.type === "response.output_text.delta") {
					delta = event.delta as string;
				} else if (event.type === "error") {
					emit({
						type: "error",
						message: String(event.message ?? "responses error"),
					});
				}
			}
			if (delta) {
				const last = messageParts.at(-1);
				if (last?.type === "text") {
					last.text += delta;
				} else {
					messageParts.push({ type: "text", text: delta });
				}
				emit({ type: "delta", text: delta });
			}
		};

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const chunks = buffer.split("\n\n");
			buffer = chunks.pop() ?? "";
			for (const chunk of chunks) {
				for (const line of chunk.split("\n")) {
					if (line.startsWith("data:")) {
						onSseData(line.slice(5).trim());
					}
				}
			}
		}
	}
}
