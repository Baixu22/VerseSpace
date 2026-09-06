import type { WorkbenchEvent } from "../types/event";

/**
 * Per-pass predicate accounting (R2 · TF-0149).
 *
 * "Too many notices or too few" is unanswerable by feeling, so every
 * reconcile pass that finds at least one overlap records where its candidate
 * claims died. The ratio `notified / overlaps` is the single number that
 * decides whether the predicate layers need tuning — and the same number is
 * the start gate for the notice budget (TF-0133) and the evidence for whether
 * layer 3 earns its keep at all (TF-0136 判决四).
 *
 * The identity that holds for every recorded pass:
 *
 *     overlaps === suppressedL2 + suppressedL3 + suppressedDedup + notified
 *
 * `suppressedL1` sits OUTSIDE that identity on purpose. Layer 1 (durability)
 * decides before the file is ever hashed, so a durable read is never asked
 * whether it overlapped; hashing every `node_modules/**` claim once per pass
 * just to make the sum close would be exactly the tax the runtime refuses
 * everywhere else. Read it as "durable reads skipped", not "overlaps
 * suppressed by layer 1".
 *
 * A pass with zero overlaps writes no event: it carries no information the
 * ratio can use, and the watcher runs a pass on every file change. So the
 * aggregate below is over overlap-bearing passes only, and `suppressedL1` is
 * a lower bound on total layer-1 suppression rather than a full census.
 */

export const PREMISE_PASS_EVENT = "premise_pass" as const;

export interface PremisePassCounts {
	/** Volatile read claims whose file content moved since it was observed. */
	overlaps: number;
	/** Layer 1: durable (generated / vendor) reads skipped before hashing. */
	suppressedL1: number;
	/** Layer 2: the file moved, the span the writer actually read did not. */
	suppressedL2: number;
	/** Layer 3: dependency read whose export surface still holds. */
	suppressedL3: number;
	/** Already reported for this (writer, path, currentVersion) triple. */
	suppressedDedup: number;
	/** Survived every layer and reached a notice. */
	notified: number;
	/** Writers examined in this pass, after the active-window filter. */
	writers: number;
}

export function emptyPassCounts(): PremisePassCounts {
	return {
		overlaps: 0,
		suppressedL1: 0,
		suppressedL2: 0,
		suppressedL3: 0,
		suppressedDedup: 0,
		notified: 0,
		writers: 0,
	};
}

/**
 * Target band for `notified / overlaps`. Above it the layers are noisy enough
 * that writers will learn to ignore notices; below it the layers are eating
 * real invalidations. Either direction is a tuning signal, never silence.
 */
export const PREMISE_NOTIFY_BAND = { low: 0.1, high: 0.3 } as const;

export type PremiseBandVerdict =
	| "in-band"
	| "too-noisy"
	| "too-quiet"
	| "no-sample";

export interface PremiseNotifyJudgement {
	/** notified / overlaps, or null when no pass has seen an overlap yet. */
	ratio: number | null;
	verdict: PremiseBandVerdict;
	/** Always populated: an out-of-band ratio names the direction to tune. */
	advice: string;
}

function percent(ratio: number): string {
	return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Judge the ratio against the band. Never silent and never fabricated: an
 * empty sample says so instead of reporting 0%, and the sample size travels
 * with the verdict so a 1-of-1 pass is not mistaken for a trend.
 */
export function judgeNotifyRatio(
	overlaps: number,
	notified: number,
): PremiseNotifyJudgement {
	if (overlaps <= 0) {
		return {
			ratio: null,
			verdict: "no-sample",
			advice:
				"尚无重叠样本：还没有任何一次 reconcile 观测到读集与写入重叠，" +
				"notified / overlaps 无法计算（不是 0%）。",
		};
	}
	const ratio = notified / overlaps;
	const sample = `样本 ${overlaps} 次重叠`;
	if (ratio > PREMISE_NOTIFY_BAND.high) {
		return {
			ratio,
			verdict: "too-noisy",
			advice:
				`通知过多：notified / overlaps = ${percent(ratio)}，高于 ${percent(PREMISE_NOTIFY_BAND.high)} 上界（${sample}）。` +
				"收紧谓词：优先让无跨度的依赖读进入第 3 层，并为高频路径补上读时跨度。",
		};
	}
	if (ratio < PREMISE_NOTIFY_BAND.low) {
		return {
			ratio,
			verdict: "too-quiet",
			advice:
				`通知过少：notified / overlaps = ${percent(ratio)}，低于 ${percent(PREMISE_NOTIFY_BAND.low)} 下界（${sample}）。` +
				"放宽谓词：先查第 3 层是否吞掉了真实失效，再查读时快照是否缺失导致第 2 层误判。",
		};
	}
	return {
		ratio,
		verdict: "in-band",
		advice: `notified / overlaps = ${percent(ratio)}，落在 ${percent(PREMISE_NOTIFY_BAND.low)}-${percent(PREMISE_NOTIFY_BAND.high)} 目标区间内（${sample}）。`,
	};
}

export interface PremisePassTotals extends PremisePassCounts {
	/** Overlap-bearing passes recorded in the log. */
	passes: number;
	notifiedRatio: number | null;
	band: { low: number; high: number };
	verdict: PremiseBandVerdict;
	advice: string;
	/**
	 * TF-0136 判决四的输入：layer 3 that never suppresses anything in real data
	 * is a layer with no evidence behind it.
	 */
	l3EverSuppressed: boolean;
}

function countOf(payload: Record<string, unknown>, key: string): number {
	const value = payload[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: 0;
}

/**
 * Fold every recorded pass into one readable set of numbers. Tolerant of old
 * or malformed payloads: a missing field reads as 0 rather than poisoning the
 * aggregate, because the ratio is only useful if it survives log evolution.
 */
export function foldPremisePasses(events: WorkbenchEvent[]): PremisePassTotals {
	const totals = emptyPassCounts();
	let passes = 0;
	for (const event of events) {
		if (event.type !== PREMISE_PASS_EVENT) {
			continue;
		}
		const payload =
			event.payload &&
			typeof event.payload === "object" &&
			!Array.isArray(event.payload)
				? (event.payload as Record<string, unknown>)
				: {};
		passes += 1;
		totals.overlaps += countOf(payload, "overlaps");
		totals.suppressedL1 += countOf(payload, "suppressedL1");
		totals.suppressedL2 += countOf(payload, "suppressedL2");
		totals.suppressedL3 += countOf(payload, "suppressedL3");
		totals.suppressedDedup += countOf(payload, "suppressedDedup");
		totals.notified += countOf(payload, "notified");
		totals.writers += countOf(payload, "writers");
	}
	const judgement = judgeNotifyRatio(totals.overlaps, totals.notified);
	return {
		...totals,
		passes,
		notifiedRatio:
			judgement.ratio === null ? null : Number(judgement.ratio.toFixed(3)),
		band: { low: PREMISE_NOTIFY_BAND.low, high: PREMISE_NOTIFY_BAND.high },
		verdict: judgement.verdict,
		advice: judgement.advice,
		l3EverSuppressed: totals.suppressedL3 > 0,
	};
}

/**
 * 近窗读数（2026-09-06 发现的防衰减伴随量）：聚合 notified/overlaps 随空闲
 * 重查的 dedup 累积自然衰减——租户实测 0.16（批次末）→ 0.058（空闲数小时），
 * 纯负载形状而非谓词失灵，任何长活部署都会如此。近 7 天窗口（与账本每周
 * 重跑的节奏一致）给「当前谓词健康度」一个不被历史稀释的伴随读数；聚合
 * 口径、band 判定与 TF-0133 的门保持权威不变。
 */
export const PREMISE_RECENT_WINDOW_MS = 7 * 86_400_000;

export function foldRecentPremisePasses(
	events: WorkbenchEvent[],
	options: { now?: number; windowMs?: number } = {},
): {
	windowDays: number;
	passes: number;
	overlaps: number;
	notified: number;
	ratio: number | null;
} {
	const now = options.now ?? Date.now();
	const windowMs = options.windowMs ?? PREMISE_RECENT_WINDOW_MS;
	const cutoff = now - windowMs;
	const recent = events.filter(
		(event) =>
			event.type === PREMISE_PASS_EVENT &&
			Number.isFinite(Date.parse(event.timestamp)) &&
			Date.parse(event.timestamp) >= cutoff,
	);
	const totals = foldPremisePasses(recent);
	return {
		windowDays: Number((windowMs / 86_400_000).toFixed(1)),
		passes: totals.passes,
		overlaps: totals.overlaps,
		notified: totals.notified,
		ratio: totals.notifiedRatio,
	};
}
