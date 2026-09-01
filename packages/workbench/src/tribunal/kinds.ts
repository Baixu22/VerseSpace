import type { TribunalKind, TribunalPriority } from "../types/tribunal";

/**
 * Per-kind baselines: consequence severity (0..1) and response deadline in
 * minutes. Priority is their product, not a hand-tuned label (ISA-18.2).
 *
 * The spread is load-bearing. After a realistic day of emitter traffic is
 * rationalized, the open queue should look like 5 / 15 / 30 / 50
 * (critical / high / medium / low). Critical is reserved for NEWS2
 * escalations; a queue where a quarter of the items are critical has failed
 * to grade, not discovered a crisis.
 *
 * Bands the baselines actually land in (score = 0.6·severity + 0.4·urgency):
 * - suppressed (below SOFT_THRESHOLD): concurrency_cap, dispatch_suggestion
 * - low, admitted, pull-only: review / no-policy / stale queue / no idle /
 *   tool-result bloat
 * - medium: dead dependency, invalidated premise, cache miss
 * - high, pushed: missing dependency, blocked/orphan workspot, lane suspend
 * - critical: never from a baseline — only `escalation.ts`
 */
export interface KindProfile {
	severity: number;
	urgencyMinutes: number;
}

export const KIND_PROFILES: Record<TribunalKind, KindProfile> = {
	dependency_missing: { severity: 0.75, urgencyMinutes: 30 },
	dependency_dead: { severity: 0.5, urgencyMinutes: 60 },
	workspot_blocked: { severity: 0.7, urgencyMinutes: 30 },
	workspot_orphan_task: { severity: 0.7, urgencyMinutes: 30 },
	// pull-style work a human owes today, not an interrupt
	checkpoint_needs_review: { severity: 0.4, urgencyMinutes: 180 },
	checkpoint_no_policy: { severity: 0.4, urgencyMinutes: 200 },
	queue_stale_entries: { severity: 0.4, urgencyMinutes: 200 },
	no_idle_workspot: { severity: 0.42, urgencyMinutes: 180 },
	concurrency_cap: { severity: 0.15, urgencyMinutes: 240 },
	dispatch_suggestion: { severity: 0.1, urgencyMinutes: 480 },
	premise_invalidated: { severity: 0.5, urgencyMinutes: 45 },
	metric_tool_bloat: { severity: 0.45, urgencyMinutes: 180 },
	metric_cache_miss: { severity: 0.55, urgencyMinutes: 45 },
	metric_suspend: { severity: 0.75, urgencyMinutes: 30 },
};

/**
 * The deadline axis, normalized over a 4-hour horizon: an event due in 5
 * minutes is urgent, one due "whenever" is not, and anything past the horizon
 * contributes nothing.
 */
export const URGENCY_HORIZON_MINUTES = 240;

export function urgencyFactor(urgencyMinutes: number): number {
	const remaining = URGENCY_HORIZON_MINUTES - Math.max(0, urgencyMinutes);
	return Math.min(1, Math.max(0, remaining / URGENCY_HORIZON_MINUTES));
}

/**
 * Combined human-facing score, 0..1. Consequence outweighs deadline (0.6 /
 * 0.4): a severe consequence nobody must act on today still outranks a
 * trivial one that is due in five minutes.
 */
export function scoreOf(severity: number, urgencyMinutes: number): number {
	return clamp01(0.6 * clamp01(severity) + 0.4 * urgencyFactor(urgencyMinutes));
}

/**
 * SLA band from the combined score. Escalated items (single red parameter)
 * jump straight to critical regardless of the score.
 */
export function priorityOf(score: number, escalated = false): TribunalPriority {
	if (escalated) {
		return "critical";
	}
	if (score >= 0.9) {
		return "critical";
	}
	if (score >= 0.7) {
		return "high";
	}
	if (score >= 0.4) {
		return "medium";
	}
	return "low";
}

/**
 * The human channel is binary (TF-0082, Zirk 2020): a conservative threshold
 * beats graded likelihood displays on both sensitivity and misses, and it
 * cannot produce a wolf-cry effect.
 *
 * - ≥ PUSH_THRESHOLD (0.70): push it.
 * - ≥ SOFT_THRESHOLD (0.30): keep it in the queue as pull-style soft
 *   summary. Not a second alarm level — it is simply not pushed.
 * - below it: not an alarm at all.
 */
export const PUSH_THRESHOLD = 0.7;
export const SOFT_THRESHOLD = 0.3;
/** A share of criticals above this means the grading failed (TF-0080 / 81). */
export const CRITICAL_SHARE_LIMIT = 0.25;
/** After rationalization a healthy queue looks like 5 / 15 / 30 / 50. */
export const TARGET_SHARES: Record<TribunalPriority, number> = {
	critical: 0.05,
	high: 0.15,
	medium: 0.3,
	low: 0.5,
};
/** 20 percentage points — "接近", not exact. */
export const SHARE_TOLERANCE = 0.2;

export function shouldPush(score: number, escalated: boolean): boolean {
	return escalated || score >= PUSH_THRESHOLD;
}

export function distributionHealthy(
	counts: Record<TribunalPriority, number>,
): boolean {
	const total = counts.critical + counts.high + counts.medium + counts.low;
	if (total === 0) {
		return true;
	}
	if (counts.critical / total > CRITICAL_SHARE_LIMIT) {
		return false;
	}
	const bands: TribunalPriority[] = ["critical", "high", "medium", "low"];
	return bands.every((band) => {
		return (
			Math.abs(counts[band] / total - TARGET_SHARES[band]) <= SHARE_TOLERANCE
		);
	});
}

export function clamp01(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.min(1, Math.max(0, value));
}
