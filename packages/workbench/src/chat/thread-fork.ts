import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

import {
	buildForkDeclaration,
	type ForkAgentPlan,
	type ForkOutcome,
	forkSlice,
} from "./fork";

import { deriveTitle } from "./promote";

import { capabilitiesOf } from "./provider-capabilities";

import type { ThreadContext } from "./thread-context";

import { turnInFlight } from "./thread-lifecycle";

import type { ThreadMeta } from "./thread-types";

export function fork(
	context: ThreadContext,
	id: string,
	anchorMessageId: string,
): Promise<ForkOutcome> {
	return context.store.enqueue(id, () =>
		forkLocked(context, id, anchorMessageId),
	);
}

/**
 * Fork without taking the source thread's queue lock. Only call this from code
 * that already holds that lock (the turn runner), or it will deadlock.
 */
export async function forkLocked(
	context: ThreadContext,
	id: string,
	anchorMessageId: string,
): Promise<ForkOutcome> {
	{
		// claude sessions stay alive BETWEEN turns (running holds the live
		// child for minutes) — refuse only when a turn is actually in flight
		if (turnInFlight(context, id)) {
			return { ok: false, reason: "线程正在运行" };
		}
		const source = await context.store.get(id);
		const sourceMessages = await context.store.messages(id);
		const sliced = forkSlice(sourceMessages, anchorMessageId);
		if (!sliced.ok) {
			return { ok: false, reason: "找不到锚点消息" };
		}
		const { inherited, anchor } = sliced;
		const config = await context.bb.config.load();
		const sourceFootprint = await context.bb.sessions.footprint(id);
		// Claude can only give a child the exact provider context when the
		// anchor is the current tail and the parent has a resumable session.
		// Older/mid-transcript forks stay fresh rather than claiming inheritance.
		const agentContextPlan: ForkAgentPlan | undefined =
			capabilitiesOf(config.chat.provider).supportsFork &&
			!context.live.get(id) &&
			source.hasResumableSession === true &&
			typeof source.claudeSessionId === "string" &&
			anchor.id === sourceMessages.at(-1)?.id
				? {
						provider: "claude",
						mode: "fork-session",
						sourceThreadId: id,
						sourceSessionId: source.claudeSessionId,
						sourceFootprintSeq: sourceFootprint.length,
					}
				: undefined;

		// 新线程：全新 uuid / 全新 agent 会话 / 无晋升记录 / 未归档；
		// 标题从继承前缀确定性推导（与晋升同规则）——零仪式，随时可改。
		const forkId = randomUUID();
		const forkMeta: ThreadMeta = {
			id: forkId,
			title: deriveTitle(inherited),
			createdAt: new Date().toISOString(),
			claudeSessionId: forkId,
			status: "idle",
			permissionMode: "default",
			forkOf: {
				sourceThreadId: id,
				sourceTitle: source.title,
				anchorMessageId,
				inheritedMessages: inherited.length,
				at: new Date().toISOString(),
				...(agentContextPlan ? { agentContextPlan } : {}),
			},
			forkInheritance: {
				transcriptInherited: true,
				agentContextInherited: null,
				premiseInherited: null,
			},
		};
		await mkdir(context.store.dir(forkId), { recursive: true });
		await writeFile(
			context.store.metaFile(forkId),
			JSON.stringify(forkMeta, null, 2),
			"utf8",
		);
		await writeFile(
			context.store.messagesFile(forkId),
			`${inherited.map((m) => JSON.stringify(m)).join("\n")}\n`,
			"utf8",
		);
		context.store.cache.set(forkId, forkMeta);
		await context.bb.sessions.register(forkId, "agent", forkMeta.title);

		// 源线程只动 meta.forks 计数；messages.jsonl 一个字节不动
		const forks = { ...(source.forks ?? {}) };
		forks[anchorMessageId] = (forks[anchorMessageId] ?? 0) + 1;
		source.forks = forks;
		await context.store.saveMeta(source);
		await context.store.appendThreadEvent("thread.forked", forkId, {
			sourceThreadId: id,
			anchorMessageId,
			transcriptInherited: true,
			...(agentContextPlan
				? {
						agentContextPlan: agentContextPlan.mode,
						sourceFootprintSeq: agentContextPlan.sourceFootprintSeq,
					}
				: {}),
		});

		return {
			ok: true,
			thread: forkMeta,
			declaration: buildForkDeclaration(
				anchor,
				inherited.length,
				undefined,
				agentContextPlan,
			),
		};
	}
}
