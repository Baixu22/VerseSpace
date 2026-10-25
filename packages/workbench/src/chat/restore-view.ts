import type { Blackboard } from "../blackboard";
import { inputCoverageView } from "../blackboard/input-coverage";
import { diffReadSet } from "../runtime/read-set-diff";
import { collectDecisionPoints } from "./ledger";
import { UNNAMED_TITLE } from "./promote";
import { resumeDelta } from "./resume";
import { buildResumeCard, isResumeCardDismissed } from "./resume-card";
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
	const [readSetDiff, events, threads] = await Promise.all([
		diffReadSet(bb, threadId, meta.resumeNote?.leaveSignature),
		bb.events.all(),
		chat.list(),
	]);
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
		}),
		resumeCardDismissed,
	};
}
