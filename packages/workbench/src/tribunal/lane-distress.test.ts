import { describe, expect, test } from "bun:test";
import { emptyUsage } from "../agents/usage";
import { derive, emptyLaneMetrics, foldUsage } from "../blackboard/metrics";
import {
	assessLane,
	evictToolResultContent,
	foldAndAssess,
	SUSPEND_COMPACTIONS,
	SUSPEND_FAILURES,
	shouldSuspend,
	TOOL_BLOAT_SHARE,
} from "./lane-distress";

describe("lane distress (TF-0084)", () => {
	test("tool-result share over 40% asks for recoverable eviction, not compaction", () => {
		let lane = emptyLaneMetrics("ws-a");
		lane = foldUsage(lane, {
			...emptyUsage(),
			toolResultBytes: 800,
			assistantTextBytes: 200,
		});
		const shown = derive(lane);
		expect(shown.toolResultShare).toBeGreaterThan(TOOL_BLOAT_SHARE);
		const distress = assessLane(shown);
		expect(distress.map((item) => item.action)).toContain("evict-tool-results");
		expect(distress.map((item) => item.action)).not.toContain("suspend");
	});

	test("a cache-hit drop forbids compaction and names the miss", () => {
		let lane = emptyLaneMetrics("ws-a");
		lane = foldUsage(lane, {
			...emptyUsage(),
			inputTokens: 10,
			cacheReadTokens: 90,
		});
		const { lane: after, distress } = foldAndAssess(lane, {
			...emptyUsage(),
			inputTokens: 100,
			cacheReadTokens: 0,
		});
		expect(derive(after).cacheHitRate).toBe(0.5);
		expect(distress.map((item) => item.action)).toContain("forbid-compaction");
		expect(distress[0]?.envelope.kind).toBe("metric_cache_miss");
	});

	test("two consecutive failures or two compactions hang the lane", () => {
		expect(SUSPEND_FAILURES).toBe(2);
		expect(SUSPEND_COMPACTIONS).toBe(2);
		let lane = emptyLaneMetrics("ws-a");
		lane = foldUsage(lane, { ...emptyUsage(), failed: true });
		expect(shouldSuspend(derive(lane))).toBe(false);
		lane = foldUsage(lane, { ...emptyUsage(), failed: true });
		expect(shouldSuspend(derive(lane))).toBe(true);
		expect(
			assessLane(derive(lane)).some((item) => item.action === "suspend"),
		).toBe(true);

		let compacted = emptyLaneMetrics("ws-b");
		compacted = foldUsage(compacted, { ...emptyUsage(), compaction: true });
		compacted = foldUsage(compacted, { ...emptyUsage(), compaction: true });
		expect(shouldSuspend(derive(compacted))).toBe(true);
	});

	test("eviction drops the body and keeps the paths", () => {
		const evicted = evictToolResultContent({
			file_path: "src/foo.ts",
			content: "x".repeat(400),
		});
		expect(evicted.evicted).toBe(true);
		expect(evicted.paths).toEqual(["src/foo.ts"]);
		expect(evicted.bytesDropped).toBeGreaterThan(400);
	});
});
