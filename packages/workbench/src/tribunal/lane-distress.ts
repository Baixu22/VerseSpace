import type { UsageSample } from "../agents/usage";
import type { DerivedLaneMetrics, LaneMetrics } from "../blackboard/metrics";
import { derive, foldUsage } from "../blackboard/metrics";
import type { TribunalEnvelope } from "../types/tribunal";
import { envelopes } from "./envelopes";

/**
 * Per-lane distress (TF-0084). Three *shapes* of failure, each one a
 * different decision:
 * - tool results ate the context → 收窄工具输出（见下方注记：这是给人的建议，
 *   不是本进程能执行的裁切）；
 * - cache hit rate dropped → do not compact, the prefix was mutated;
 * - compacted twice or failed twice in a row → hang the lane and reseed
 *   from filesystem notes + git diff.
 *
 * Pure: the caller decides when to submit the envelope. Folding twins is the
 * queue's job, so firing this on every sample is cheap and correct.
 *
 * ⚠ 2026-09-13 收尾 §4.2/§4.6：此前这里有一个 `evictToolResultContent()`，
 * 自称「TF-0084 唯一允许的上下文裁切」，但**没有任何生产路径能执行它**——
 * claude 车道的上下文活在 CLI 子进程里，HTTP 车道的 history 只回放消息文本、
 * 不回放工具结果。没有执行者的裁切函数只会让读者以为裁切已经在发生，故删除。
 * `evict-tool-results` 这个动作保留为**给人的建议**（信封里就是收窄工具输出），
 * 不再假装机器会自己动手。
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
 * 折叠一次用量样本并立刻判定：`agents/runner.ts` 每个 sample 走这一步。
 * 组合在一起而不是让调用方自己拼，是因为顺序有语义——`distress` 必须拿
 * 折叠**之前**的派生值做基线（缓存命中率是逐轮读数，折叠两次就看不见下降）。
 */
export function foldAndAssess(
	lane: LaneMetrics,
	sample: UsageSample,
): { lane: LaneMetrics; distress: LaneDistress[] } {
	const previous = derive(lane);
	const next = foldUsage(lane, sample);
	return { lane: next, distress: assessLane(derive(next), previous) };
}
