import type {
	RationalizationRule,
	TribunalCandidate,
	TribunalItem,
} from "../types/tribunal";

// RejectionRule is used by the queue's SubmitResult; re-exported here so the
// gate and the queue share one vocabulary for "why an event was refused".
export type { RejectionRule } from "../types/tribunal";

import { scanEscalation } from "./escalation";
import {
	clamp01,
	KIND_PROFILES,
	PUSH_THRESHOLD,
	priorityOf,
	SOFT_THRESHOLD,
	scoreOf,
	URGENCY_HORIZON_MINUTES,
} from "./kinds";

/**
 * The ISA-18.2 rationalization gate (TF-0081) — the QUALITATIVE half.
 *
 * Industrial plants that run this pass delete 40–60% of their configured
 * alarms, and the remaining ones get answered. The five tests, in the order
 * they are applied:
 *
 * 1. abnormal — is this actually off-normal? (severity > 0)
 * 2. consequence — can we say what happens if nobody acts?
 * 3. actionable — is there a defined action? An event with no defined action
 *    is not an alarm, and "the human will think of something" is not an
 *    action.
 * 4. relevant — does it name the thing it is about?
 * 5. unique — does it carry a cause key so duplicates can be folded?
 *
 * Rejections are returned, not thrown: the queue records why an event never
 * reached a human, which is the only way to keep the gate itself honest.
 *
 * The quantitative floor (soft threshold) is deliberately NOT applied here.
 * It is a queue decision, and it must run after causal suppression: the
 * thirtieth session interrupted by one dead dependency scores low on its own,
 * yet folding it is exactly how the queue notices the cause matters. See
 * `belowSoftFloor` and `tribunal/queue.ts`.
 */

export type Rationalization =
	| { admit: true; draft: Omit<TribunalItem, "id"> }
	| { admit: false; rule: RationalizationRule; reason: string };

function blank(value: string | undefined): boolean {
	return value === undefined || value.trim().length === 0;
}

export function rationalize(
	candidate: TribunalCandidate,
	at = new Date().toISOString(),
): Rationalization {
	const profile = KIND_PROFILES[candidate.kind];
	const severity = clamp01(candidate.severity ?? profile.severity);
	const urgencyMinutes = Math.max(
		1,
		Math.trunc(candidate.urgencyMinutes ?? profile.urgencyMinutes),
	);

	// 1. abnormal: severity 0 means the emitter is reporting a state, not an
	// event. States belong in the dashboard, not in a human's face.
	if (severity <= 0) {
		return {
			admit: false,
			rule: "abnormal",
			reason: `${candidate.kind} 的后果严重度为 0，属于状态描述而非异常事件`,
		};
	}

	// 2. consequence: if we cannot say what happens, the human has to
	// reconstruct it — which is the work the alarm was supposed to save.
	if (blank(candidate.sbar.assessment)) {
		return {
			admit: false,
			rule: "consequence",
			reason: `${candidate.kind} 没有说明后果（SBAR 的 assessment 为空）`,
		};
	}

	// 3. actionable: the load-bearing rule. "没有既定动作的不是告警."
	if (blank(candidate.action.label)) {
		return {
			admit: false,
			rule: "actionable",
			reason: `${candidate.kind} 没有既定动作，人看到了也做不出不一样的事`,
		};
	}

	// 4. relevant: an alarm about nothing in particular is noise.
	if (blank(candidate.subject)) {
		return {
			admit: false,
			rule: "relevant",
			reason: `${candidate.kind} 没有指明对象（subject 为空）`,
		};
	}

	// 5. unique: without a cause key the queue cannot fold twins, so every
	// repetition becomes its own alarm. That is how alarm floods start.
	if (blank(candidate.causeKey) && blank(candidate.subject)) {
		return {
			admit: false,
			rule: "unique",
			reason: `${candidate.kind} 没有因果键，无法抑制重复`,
		};
	}

	const escalation = scanEscalation(candidate.evidence);
	const score = scoreOf(severity, urgencyMinutes);
	const push = escalation !== null || score >= PUSH_THRESHOLD;

	return {
		admit: true,
		draft: {
			kind: candidate.kind,
			priority: priorityOf(score, escalation !== null),
			severity,
			urgencyMinutes,
			score,
			push,
			escalated: escalation !== null,
			escalationReason: escalation?.reason,
			subject: candidate.subject,
			causeKey: candidate.causeKey ?? `${candidate.kind}:${candidate.subject}`,
			action: { ...candidate.action },
			sbar: { ...candidate.sbar },
			folded: [],
			state: "pending",
			shelveCount: 0,
			createdAt: at,
			updatedAt: at,
		},
	};
}

/**
 * The quantitative floor, checked by the QUEUE only when an event has no
 * cause-twin to fold into: below it the event is not an alarm at all and
 * never enters the queue.
 *
 * The split is load-bearing. Folding is how the queue notices that a cause
 * matters even though every individual event scores low — but folding can
 * only happen if the FIRST event of that cause was admitted, and the first
 * event has no twin. So the floor is applied on the create path only; once an
 * item exists, its twins ride along regardless of their own score.
 *
 * The reason string names the floor so the suppression stays auditable.
 */
export function belowSoftFloor(draft: Omit<TribunalItem, "id">): string | null {
	if (draft.push || draft.score >= SOFT_THRESHOLD) {
		return null;
	}
	return `${draft.kind} 的综合分 ${draft.score.toFixed(2)} 低于软阈值 ${SOFT_THRESHOLD}，不进入队列`;
}

/**
 * A human-readable account of how an item was graded — `workbench tribunal
 * <id>` shows it so the priority is never an unexplained number.
 */
export function explainGrading(draft: {
	kind: TribunalCandidate["kind"];
	severity: number;
	urgencyMinutes: number;
	score: number;
	escalated: boolean;
}): string {
	const parts = [
		`后果 ${(draft.severity * 100).toFixed(0)}% × 时限 ${draft.urgencyMinutes} 分钟（${URGENCY_HORIZON_MINUTES} 分钟为 0）`,
		`综合分 ${draft.score.toFixed(2)}`,
	];
	if (draft.escalated) {
		parts.push("单参数越级 → critical");
	}
	return parts.join("；");
}

export { PUSH_THRESHOLD, SOFT_THRESHOLD };
