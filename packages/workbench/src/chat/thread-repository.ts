import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blackboard } from "../blackboard";

import { BlackboardDataError } from "../errors";
import type { WorkbenchEvent } from "../types/event";
import type { StoredMessage, ThreadMeta } from "./thread-types";

/**
 * One listing of `threads/`: the metas that parsed, plus the ids that did not.
 *
 * The two cases that used to collapse into `[]` are different facts: "you have
 * no conversations yet" and "I could not look". Reporting the second as the
 * first empties the sidebar while telling the user nothing is wrong.
 */
export interface ThreadListReport {
	threads: ThreadMeta[];
	/** Thread ids under `threads/` whose meta could not be read. */
	unreadable: string[];
}

export class ThreadRepository {
	readonly cache = new Map<string, ThreadMeta>();
	private queues = new Map<string, Promise<unknown>>();
	constructor(private bb: Blackboard) {}
	async appendThreadEvent(
		type: string,
		threadId: string,
		payload: Record<string, unknown> = {},
	): Promise<WorkbenchEvent> {
		// The method's id is authoritative; a caller-supplied threadId must not
		// be able to redirect an observation to another thread.
		return this.bb.events.appendThread(type, { ...payload, threadId });
	}

	dir(id: string): string {
		return join(this.bb.paths.root, "threads", id);
	}

	metaFile(id: string): string {
		return join(this.dir(id), "meta.json");
	}

	messagesFile(id: string): string {
		return join(this.dir(id), "messages.jsonl");
	}

	/**
	 * The thread list WITH its diagnostics: the metas that parsed, plus the ids
	 * that could not be read.
	 *
	 * Two very different facts used to collapse into `[]` here. A missing
	 * `threads/` directory is genuinely "no conversations yet" and stays empty.
	 * A directory that EXISTS but cannot be listed is not empty — it is
	 * unreadable, and reporting it as empty silently clears the user's whole
	 * conversation list. That case throws, with the path, instead.
	 */
	async listReport(): Promise<ThreadListReport> {
		const dir = join(this.bb.paths.root, "threads");
		let ids: string[];
		try {
			ids = await readdir(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { threads: [], unreadable: [] };
			}
			throw new BlackboardDataError(
				`cannot read the threads directory: ${String(error)}`,
				dir,
			);
		}
		const unreadable: string[] = [];
		const metas = await Promise.all(
			ids.map(async (id) => {
				try {
					return await this.get(id);
				} catch (error) {
					// One unreadable thread must not hide its siblings — but it
					// must not vanish either. It is named, here and on stderr.
					unreadable.push(id);
					console.error(`[chat] 无法读取对话 ${id}（已从列表中省略）:`, error);
					return null;
				}
			}),
		);
		return {
			threads: metas
				.filter((meta): meta is ThreadMeta => meta !== null)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
			unreadable,
		};
	}

	async list(): Promise<ThreadMeta[]> {
		return (await this.listReport()).threads;
	}

	async create(title?: string): Promise<ThreadMeta> {
		// the thread id IS the claude session id: one identifier everywhere
		const id = randomUUID();
		const meta: ThreadMeta = {
			id,
			title: title?.trim() || "新对话",
			createdAt: new Date().toISOString(),
			claudeSessionId: id,
			status: "idle",
			permissionMode: "default",
		};
		await mkdir(this.dir(id), { recursive: true });
		await writeFile(this.metaFile(id), JSON.stringify(meta, null, 2), "utf8");
		await writeFile(this.messagesFile(id), "", "utf8");
		this.cache.set(id, meta);
		// register the thread as an agent writer (R1: citizens, not ghosts)
		await this.bb.sessions.register(id, "agent", meta.title);
		await this.appendThreadEvent("thread.created", id, { title: meta.title });
		return meta;
	}

	async get(id: string): Promise<ThreadMeta> {
		const cached = this.cache.get(id);
		if (cached) {
			return cached;
		}
		const meta = JSON.parse(
			await readFile(this.metaFile(id), "utf8"),
		) as ThreadMeta;
		this.cache.set(id, meta);
		return meta;
	}

	async messages(id: string): Promise<StoredMessage[]> {
		const raw = await readFile(this.messagesFile(id), "utf8");
		return raw
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as StoredMessage);
	}

	async appendMessage(id: string, message: StoredMessage): Promise<void> {
		const { appendFile } = await import("node:fs/promises");
		await appendFile(
			this.messagesFile(id),
			`${JSON.stringify(message)}\n`,
			"utf8",
		);
	}

	async saveMeta(meta: ThreadMeta): Promise<void> {
		this.cache.set(meta.id, meta);
		await writeFile(
			this.metaFile(meta.id),
			JSON.stringify(meta, null, 2),
			"utf8",
		);
	}

	enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
		const prev = this.queues.get(id) ?? Promise.resolve();
		const next = prev.then(task, task);
		this.queues.set(
			id,
			// 判定（2026-09-13 收尾 §4.5 复核）：这里吞掉是**有意**的——队列
			// 链只需要一个「已结算」的接力棒，真实错误通过返回的 `next` 交给
			// 调用方，不是静默丢弃。
			next.catch(() => {}),
		);
		return next;
	}

	async update(
		id: string,
		patch: Partial<Pick<ThreadMeta, "title" | "permissionMode" | "archived">>,
	): Promise<ThreadMeta> {
		const meta = await this.get(id);
		if (patch.title !== undefined) {
			meta.title = patch.title;
		}
		if (patch.permissionMode !== undefined) {
			meta.permissionMode = patch.permissionMode;
		}
		if (patch.archived !== undefined) {
			meta.archived = patch.archived;
		}
		await this.saveMeta(meta);
		return meta;
	}
}
