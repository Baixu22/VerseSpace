import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import type { ThreadContext } from "./thread-context";

export function cancel(context: ThreadContext, id: string): void {
	const handle = context.running.get(id);
	if (handle instanceof AbortController) {
		handle.abort();
	} else if (handle) {
		// supervisor kill = tree kill: on Windows the cmd.exe shim AND the
		// claude process under it both die (a bare kill() orphaned claude)
		void handle.kill();
	}
}

export async function remove(
	context: ThreadContext,
	id: string,
): Promise<{ ok: boolean; reason?: string }> {
	if (context.live.get(id)) {
		// a live session dies with its thread (the transcript lives here)
		cancel(context, id);
	} else if (context.running.get(id)) {
		return { ok: false, reason: "线程正在运行" };
	}
	const { rm } = await import("node:fs/promises");
	await rm(context.store.dir(id), { recursive: true, force: true });
	context.store.cache.delete(id);
	return { ok: true };
}

export async function reload(
	context: ThreadContext,
	id: string,
): Promise<{ ok: boolean; userText?: string; reason?: string }> {
	return context.store.enqueue(id, async () => {
		// claude sessions stay alive BETWEEN turns (running holds the live
		// child for minutes) — refuse only when a turn is actually in flight
		if (turnInFlight(context, id)) {
			return { ok: false, reason: "线程正在运行" };
		}
		const messages = await context.store.messages(id);
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
			context.store.messagesFile(id),
			`${kept.map((m) => JSON.stringify(m)).join("\n")}${kept.length ? "\n" : ""}`,
			"utf8",
		);
		// TF-0092 触发信号「同一条消息上第二次分叉」：分叉锚点消息计数。
		const anchor = kept.at(-1)?.id;
		if (anchor) {
			const meta0 = await context.store.get(id);
			const forks = { ...(meta0.forks ?? {}) };
			forks[anchor] = (forks[anchor] ?? 0) + 1;
			meta0.forks = forks;
			await context.store.saveMeta(meta0);
		}
		// claude resume context diverges after truncation — mint a fresh
		// session id (the thread directory keeps its name; the NEXT claude
		// session gets the new uuid via --session-id). A live session is
		// killed first: it holds the OLD session.
		if (context.live.get(id)) {
			cancel(context, id);
			const deadline = Date.now() + 3000;
			while (context.live.get(id) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
		const meta = await context.store.get(id);
		meta.claudeSessionId = randomUUID();
		meta.hasResumableSession = false;
		await context.store.saveMeta(meta);
		return { ok: true, userText };
	});
}

export function turnInFlight(context: ThreadContext, id: string): boolean {
	return (
		context.running.get(id) instanceof AbortController ||
		Boolean(context.live.get(id)?.turn)
	);
}
