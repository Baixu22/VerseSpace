import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blackboard } from "../blackboard";

import type { WorkbenchEvent } from "../types/event";
import type { StoredMessage, ThreadMeta } from "./thread-types";

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
