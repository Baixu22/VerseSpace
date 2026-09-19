import { randomUUID } from "node:crypto";

import {
	collectSignals,
	countUserTurns,
	evaluatePromotion,
	type PromotionSignal,
	promotionPatch,
	UNNAMED_TITLE,
} from "./promote";

import type { ThreadContext } from "./thread-context";

import type { AdoptSnapshot, ThreadMeta } from "./thread-types";

export async function maybePromote(
	context: ThreadContext,
	id: string,
	extraSignals: PromotionSignal[] = [],
): Promise<ThreadMeta> {
	const meta = await context.store.get(id);
	const messages = await context.store.messages(id);
	// 二次分叉信号：任意一条消息被分叉（含 reload）达到 2 次
	const forkSignals: PromotionSignal[] = Object.entries(meta.forks ?? {})
		.filter(([, count]) => count >= 2)
		.map(([atMessageId]) => ({ kind: "second-fork", atMessageId }));
	const signals = collectSignals(messages, {
		extraSignals: [...forkSignals, ...extraSignals],
	});
	const verdict = evaluatePromotion({
		title: meta.title,
		userTurnCount: countUserTurns(messages),
		signals,
	});
	if (!verdict.promote) {
		return meta;
	}
	const patch = promotionPatch(messages, verdict.signals);
	meta.title = patch.title;
	meta.promotion = patch.promotion;
	await context.store.saveMeta(meta);
	return meta;
}

export async function promote(
	context: ThreadContext,
	id: string,
): Promise<ThreadMeta> {
	return context.store.enqueue(id, async () => {
		const meta = await context.store.get(id);
		if (meta.title !== UNNAMED_TITLE) {
			return meta;
		}
		const messages = await context.store.messages(id);
		const patch = promotionPatch(messages, [], new Date());
		if (patch.title === UNNAMED_TITLE) {
			return meta; // 空对话没有可派生的名字
		}
		meta.title = patch.title;
		meta.promotion = patch.promotion;
		await context.store.saveMeta(meta);
		return meta;
	});
}

/**
 * 收养：一次身份迁移，不搬内容。子线程升为主线、源线程就地归档，双方消息
 * 一字不动。单事务原子完成（打快照 + 提升 + 归档），失败即整体回滚。不做
 * revert（下轮）。TODO：`thread.adopted` 须先登记进 THREAD_EVENT_TYPES 白名单
 * （types/event.ts），否则 validateThreadEvent 拦截丢弃。
 */
export async function adoptThread(
	context: ThreadContext,
	adoptedThreadId: string,
	refs: string[] = [],
): Promise<string> {
	return context.store.enqueue(adoptedThreadId, async () => {
		const adopted = await context.store.get(adoptedThreadId);
		const lineage = adopted.forkOf;
		if (!lineage) {
			throw new Error("只能收养分叉线程：缺少 forkOf 血统");
		}
		const source = await context.store.get(lineage.sourceThreadId);
		const sourceMessages = await context.store.messages(source.id);
		const anchor = sourceMessages.at(-1);
		const snapshot: AdoptSnapshot = {
			id: randomUUID(),
			version: 1,
			sourceThreadId: source.id,
			sourceArchivedBefore: source.archived ?? false,
			adoptedThreadId: adopted.id,
			adoptedForkOfBefore: lineage,
			adoptedArchivedBefore: adopted.archived ?? false,
			anchorMessageId: anchor?.id,
			at: new Date().toISOString(),
		};
		// 子线程升主线：清 forkOf，取消归档，挂快照溯源。
		adopted.forkOf = undefined;
		adopted.archived = false;
		await context.store.saveMeta(adopted);
		// 源线程就地归档：仍可见、可检索，不删内容。整份快照挂在源线程上供反转
		// 定位——revert 需要 adoptedThreadId / *Before 才能还原身份，只存指针不够。
		source.archived = true;
		source.adoptSnapshot = snapshot;
		await context.store.saveMeta(source);
		await context.store.appendThreadEvent("thread.adopted", adopted.id, {
			newMainThreadId: adopted.id,
			sourceThreadId: source.id,
			anchorMessageId: snapshot.anchorMessageId,
			snapshotVersion: snapshot.version,
			refs,
		});
		return snapshot.id;
	});
}

/**
 * 反转收养：消费源线程上的整份快照，把双方身份复归收养前——源线程解档、
 * 子线程还原 forkOf 与 archived、清空快照，落 thread.adoption_reverted。
 * 单事务原子完成；无快照即抛错。TODO：`thread.adoption_reverted` 须先登记进
 * 事件白名单（types/event.ts），否则 validateThreadEvent 拦截丢弃。
 */
export async function revertAdopt(
	context: ThreadContext,
	sourceThreadId: string,
	refs: string[] = [],
): Promise<void> {
	return context.store.enqueue(sourceThreadId, async () => {
		const source = await context.store.get(sourceThreadId);
		if (!source.adoptSnapshot) {
			throw new Error("无可反转的收养快照");
		}
		const snapshot = source.adoptSnapshot;
		const adopted = await context.store.get(snapshot.adoptedThreadId);
		// 子线程降回：还原血统与归档态。
		adopted.forkOf = snapshot.adoptedForkOfBefore;
		adopted.archived = snapshot.adoptedArchivedBefore;
		await context.store.saveMeta(adopted);
		// 源线程复归：还原归档态，清空快照（一次性消费）。
		source.archived = snapshot.sourceArchivedBefore;
		source.adoptSnapshot = undefined;
		await context.store.saveMeta(source);
		await context.store.appendThreadEvent(
			"thread.adoption_reverted",
			source.id,
			{
				sourceThreadId: source.id,
				adoptedThreadId: snapshot.adoptedThreadId,
				snapshotId: snapshot.id,
				refs,
			},
		);
	});
}
