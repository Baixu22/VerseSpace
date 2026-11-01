import { artifactReviewProjection } from "../artifacts/projection";
import type { Blackboard } from "../blackboard";
import { inputCoverageView } from "../blackboard/input-coverage";
import { pendingPremiseNotices } from "../runtime/delivery";
import { diffReadSet } from "../runtime/read-set-diff";
import { readSessionContinuity } from "./continuity";
import { collectDecisionPoints } from "./ledger";
import { UNNAMED_TITLE } from "./promote";
import { resumeDelta } from "./resume";
import {
	buildResumeCard,
	continuityCardRows,
	isResumeCardDismissed,
} from "./resume-card";
import { branchResumeFacts } from "./resume-card/branches";
import { suggestNext } from "./suggest";
import type { ChatThreads } from "./threads";

/** The restore surface is a projection; GET never invents lifecycle events. */
export async function collectRestoreView(
	bb: Blackboard,
	chat: ChatThreads,
	threadId: string,
) {
	const [meta, messages] = await Promise.all([
		chat.get(threadId),
		chat.messages(threadId),
	]);
	// TF-0324：延续性投影与读集 diff 并行取——两者都从已有事实推导，GET 仍然
	// 不落任何事件（ADR-0027 的只读边界）。
	const [readSetDiff, events, threads, pending] = await Promise.all([
		diffReadSet(bb, threadId, meta.resumeNote?.leaveSignature),
		bb.events.all(),
		chat.list(),
		pendingPremiseNotices(bb),
	]);
	const continuity = await readSessionContinuity(bb, threadId, undefined, {
		events,
		pending,
	});
	const continuityCard = continuityCardRows({
		state: continuity.state,
		interruptions: continuity.turns.interruptions,
		pendingNotices: continuity.delivery.pendingNotices,
	});
	const resumeCardDismissed = isResumeCardDismissed(
		events,
		threadId,
		readSetDiff.baseline?.eventId,
	);
	// TF-0197：分支行的 L1 摘要要读接口注册表与 checkpoint（async），先算好
	// 再进卡片。投影仍然只读——GET 不落任何事件。
	const branchFacts = await branchResumeFacts({
		bb,
		threadId,
		threads,
		diff: readSetDiff,
		events,
	});
	return {
		meta,
		artifactReviews: await artifactReviewProjection(bb, threadId),
		inputCoverage: await inputCoverageView(
			bb,
			threadId,
			meta.lastRun?.readObservability,
		),
		messages,
		suggestions: suggestNext(messages),
		decisionPoints: collectDecisionPoints(messages, meta),
		resumeNote: meta.resumeNote ?? null,
		// 「你不在时变了什么」：服务端算好随载荷下发，客户端直接读
		// （2026-09-13 收尾 §5.6——此前客户端内联重算了同一算式）。
		resumeDelta: meta.resumeNote ? resumeDelta(messages, meta.resumeNote) : 0,
		// TF-0092 手动晋升手势的可见性由服务端判定：无名（= `UNNAMED_TITLE`）
		// 且已有内容才值得给一个手势。客户端只渲染，不复制「无名」这个判断
		// ——否则又是第二份常量（2026-09-13 收尾 §4.4）。
		canPromote:
			meta.title === UNNAMED_TITLE && messages.some((m) => m.role === "user"),
		readSetDiff,
		resumeCard: buildResumeCard({
			note: meta.resumeNote ?? null,
			diff: readSetDiff,
			dismissed: resumeCardDismissed,
			branchFacts,
			continuityFacts: continuityCard.rows,
		}),
		resumeCardDismissed,
		// 与卡片分开下发：intact 会话卡片不新增任何元素，但「有未投递积压」
		// 仍是可从载荷读到的独立事实（与 CLI 的 `~` 同一维度）。`priority`
		// 是断点 × 积压的联合判读（TF-0331），两维各自可核对。
		continuityDelivery: {
			...continuityCard.delivery,
			priority: continuityCard.priority,
		},
	};
}
