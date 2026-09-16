import {
	collectSignals,
	countUserTurns,
	evaluatePromotion,
	type PromotionSignal,
	promotionPatch,
	UNNAMED_TITLE,
} from "./promote";

import type { ThreadContext } from "./thread-context";

import type { ThreadMeta } from "./thread-types";

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
