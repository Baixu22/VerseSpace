import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";

import type { ThreadContext } from "./thread-context";

/**
 * 用户主动停止当前回合并留下一条观察（阶段三 TF-0330）。
 *
 * 只有在**确实有一个在跑的回合**时才落 `thread.turn_cancelled`：没有东西可
 * 停就不是终止事实，凭空写一条会把「用户按了停」变成可以伪造的记录。写入
 * 失败不能让 stop 失败——停不下来比少一条观察更糟，所以只报错、不抛。
 *
 * 返回是否真的发出了 abort（同步部分）；观察写入的落地由返回的 Promise 表示，
 * 调用方可以 await 它——事件必须在下游读取（延续性投影、GET 载荷）之前落盘。
 * 没有东西可停时返回 `false` 且不写任何观察：凭空写一条会把「用户按了停」
 * 变成可以伪造的记录。
 */
export async function cancel(
	context: ThreadContext,
	id: string,
): Promise<boolean> {
	const handle = context.running.get(id);
	if (!handle) {
		return false;
	}
	if (handle instanceof AbortController) {
		handle.abort();
	} else {
		// supervisor kill = tree kill: on Windows the cmd.exe shim AND the
		// claude process under it both die (a bare kill() orphaned claude)
		void handle.kill();
	}
	// 观察到「用户终止了这一轮」：带当时的消息条数，供延续性投影区分
	// 「被切断」（没有对应终止观察）与「被主动停下」。写入失败不能让已发出的
	// abort 回滚——停不下来比少一条观察更糟，所以只报错、不抛。
	const messages = await context.store.messages(id).catch(() => []);
	await context.store
		.appendThreadEvent("thread.turn_cancelled", id, {
			source: "user",
			atMessageCount: messages.length,
			lastMessageId: messages.at(-1)?.id ?? null,
			lastMessageRole: messages.at(-1)?.role ?? null,
		})
		.catch((error: unknown) => {
			console.error(
				`[chat] 线程 ${id} 的终止观察写入失败（仍已发出 abort）:`,
				error,
			);
		});
	return true;
}

export async function remove(
	context: ThreadContext,
	id: string,
): Promise<{ ok: boolean; reason?: string }> {
	if (context.live.get(id) || context.liveCodex.get(id)) {
		// a live session dies with its thread (the transcript lives here) — for
		// the codex lane this is the only way an idle thread becomes deletable
		// inside the idle-close window
		await cancel(context, id);
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
			await cancel(context, id);
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
		Boolean(context.live.get(id)?.turn) ||
		// TF-0249: the codex lane has no `turn` field — `route` is installed for
		// exactly the span of one turn, so it is the same signal.
		context.liveCodex.get(id)?.route !== undefined
	);
}
