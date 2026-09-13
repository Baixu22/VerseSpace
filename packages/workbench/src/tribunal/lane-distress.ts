import type { UsageSample } from "../agents/usage";
import type { DerivedLaneMetrics, LaneMetrics } from "../blackboard/metrics";
import { derive, foldUsage } from "../blackboard/metrics";
import type { TribunalEnvelope } from "../types/tribunal";
import { envelopes } from "./envelopes";

/**
 * Per-lane distress (TF-0084). Three *shapes* of failure, each one a
 * different decision:
 * - tool results ate the context → drop their bodies, keep the paths
 *   (recoverable eviction, never mid-context trimming);
 * - cache hit rate dropped → do not compact, the prefix was mutated;
 * - compacted twice or failed twice in a row → hang the lane and reseed
 *   from filesystem notes + git diff.
 *
 * Pure: the caller decides when to submit the envelope and when to
 * actually evict. Folding twins is the queue's job, so firing this on
 * every sample is cheap and correct.
 */

export const TOOL_BLOAT_SHARE = 0.4;
export const SUSPEND_COMPACTIONS = 2;
export const SUSPEND_FAILURES = 2;
/** A 5pp drop is a real miss, not a rounding wobble. */
export const CACHE_HIT_DROP = 0.05;

export type LaneDistress = {
	action: "evict-tool-results" | "forbid-compaction" | "suspend";
	envelope: TribunalEnvelope;
};

export function shouldSuspend(
	lane: Pick<DerivedLaneMetrics, "compactions" | "consecutiveFailures">,
): boolean {
	return (
		lane.consecutiveFailures >= SUSPEND_FAILURES ||
		lane.compactions >= SUSPEND_COMPACTIONS
	);
}

export function assessLane(
	current: DerivedLaneMetrics,
	previous?: DerivedLaneMetrics,
): LaneDistress[] {
	const out: LaneDistress[] = [];
	if (shouldSuspend(current)) {
		out.push({
			action: "suspend",
			envelope: envelopes.metricSuspend(
				current.workspot,
				Math.max(current.consecutiveFailures, current.compactions),
			),
		});
	}
	if (current.toolResultShare > TOOL_BLOAT_SHARE) {
		out.push({
			action: "evict-tool-results",
			envelope: envelopes.metricToolBloat(
				current.workspot,
				current.toolResultShare,
			),
		});
	}
	if (
		previous !== undefined &&
		previous.turns >= 1 &&
		current.turns > previous.turns &&
		current.cacheHitRate < previous.cacheHitRate - CACHE_HIT_DROP
	) {
		out.push({
			action: "forbid-compaction",
			envelope: envelopes.metricCacheMiss(
				current.workspot,
				current.cacheHitRate,
			),
		});
	}
	return out;
}

/**
 * 预留导出（仅测试消费，2026-09-13 审计 §4.2）：fold+assess 的组合步，
 * 生产路径在 agents/runner.ts 内联同一组合。
 */
export function foldAndAssess(
	lane: LaneMetrics,
	sample: UsageSample,
): { lane: LaneMetrics; distress: LaneDistress[] } {
	const previous = derive(lane);
	const next = foldUsage(lane, sample);
	return { lane: next, distress: assessLane(derive(next), previous) };
}

/**
 * Recoverable eviction: throw away the tool-result body, keep every path
 * the body named so the agent can re-read the file instead of remembering
 * it. This is the only context cut TF-0084 allows — not a summary of a
 * summary, not a mid-window trim.
 *
 * ⚠ 预留导出（仅测试消费，2026-09-13 审计 §4.2）：TF-0084 允许的唯一
 * 上下文裁切，目前**无生产调用方执行该裁切**——接线或删除待拍板。
 */
export function evictToolResultContent(content: unknown): {
	evicted: true;
	paths: string[];
	bytesDropped: number;
} {
	const paths: string[] = [];
	const acc = { n: 0 };
	collectPaths(content, paths, acc);
	return {
		evicted: true,
		paths: [...new Set(paths)],
		bytesDropped: acc.n,
	};
}

function collectPaths(
	value: unknown,
	paths: string[],
	acc: { n: number },
): void {
	if (typeof value === "string") {
		acc.n += value.length;
		if (
			value.length < 260 &&
			value.length > 0 &&
			/[\\/]/.test(value) &&
			!value.includes("\n")
		) {
			paths.push(value);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			collectPaths(item, paths, acc);
		}
		return;
	}
	if (value && typeof value === "object") {
		const rec = value as Record<string, unknown>;
		for (const key of ["path", "file_path", "filePath"]) {
			if (typeof rec[key] === "string" && rec[key].length > 0) {
				paths.push(rec[key]);
			}
		}
		for (const nested of Object.values(rec)) {
			collectPaths(nested, paths, acc);
		}
	}
}
