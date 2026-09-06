import type { Blackboard } from "../blackboard";
import { diffReadSet } from "../runtime/read-set-diff";
import { collectDecisionPoints } from "./ledger";
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
	return {
		meta,
		messages,
		suggestions: suggestNext(messages),
		decisionPoints: collectDecisionPoints(messages, meta),
		resumeNote: meta.resumeNote ?? null,
		readSetDiff,
		resumeCard: buildResumeCard({
			note: meta.resumeNote ?? null,
			diff: readSetDiff,
			dismissed: resumeCardDismissed,
			branchFacts: branchResumeFacts({
				threadId,
				threads,
				diff: readSetDiff,
				events,
			}),
		}),
		resumeCardDismissed,
	};
}
