import { describe, expect, test } from "bun:test";
import { derive, emptyLaneMetrics, foldUsage } from "../blackboard/metrics";
import { makeTempWorkbench } from "../test/fixtures";
import { emptyUsage, extractUsage } from "./usage";

/** One assistant turn with a four-way token split. */
function assistantTurn(usage: Record<string, number> = {}) {
	return {
		type: "assistant",
		message: {
			usage: {
				input_tokens: 100,
				output_tokens: 20,
				cache_creation_input_tokens: 300,
				cache_read_input_tokens: 900,
				...usage,
			},
			content: [
				{ type: "text", text: "我先看一下这个文件" },
				{ type: "tool_use", id: "t1", name: "Read" },
			],
		},
	};
}

describe("stream-json usage extraction (TF-0084)", () => {
	test("absolute tokens are read from the usage object, not a fill percentage", () => {
		const sample = extractUsage(assistantTurn());
		expect(sample).not.toBeNull();
		expect(sample?.inputTokens).toBe(100);
		expect(sample?.outputTokens).toBe(20);
		expect(sample?.cacheCreationTokens).toBe(300);
		expect(sample?.cacheReadTokens).toBe(900);
		// tool_use blocks counted, assistant text measured in bytes
		expect(sample?.toolCalls).toBe(1);
		expect(sample?.assistantTextBytes).toBe(9);
	});

	test("a compact boundary is counted as a compaction", () => {
		const sample = extractUsage({
			type: "system",
			subtype: "compact_boundary",
		});
		expect(sample?.compaction).toBe(true);
	});

	test("a failed result is flagged so consecutive failures can be counted", () => {
		expect(extractUsage({ type: "result", subtype: "success" })?.failed).toBe(
			false,
		);
		expect(
			extractUsage({ type: "result", subtype: "error_during_execution" })
				?.failed,
		).toBe(true);
		expect(extractUsage({ type: "result", is_error: true })?.failed).toBe(true);
	});

	test("tool results are measured on the user turn that carries them", () => {
		const sample = extractUsage({
			type: "user",
			message: {
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(500) },
					{ type: "tool_result", tool_use_id: "t2", content: "y".repeat(500) },
				],
			},
		});
		expect(sample?.toolCalls).toBe(2);
		expect(sample?.toolResultBytes).toBe(1000);
	});

	test("lines with nothing to count are skipped, not counted as zero", () => {
		expect(extractUsage({ type: "system", subtype: "init" })).toBeNull();
		expect(
			extractUsage({ type: "assistant", message: { content: [] } }),
		).toBeNull();
		expect(extractUsage({ type: "user", message: { content: [] } })).toBeNull();
	});
});

describe("lane metrics (TF-0084)", () => {
	test("three numbers per lane: absolute tokens, cache hit rate, compactions", () => {
		// folded one sample at a time, exactly as a live capture does —
		// accumulating first would collapse three turns into one
		{
			let lane = emptyLaneMetrics("ws-a");
			const fold = (event: Record<string, unknown>) => {
				lane = foldUsage(lane, extractUsage(event)!);
			};
			// turn 1: cache miss (creation only)
			fold(
				assistantTurn({
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 500,
				}),
			);
			// turns 2 and 3: served from cache
			fold(assistantTurn({ cache_creation_input_tokens: 0 }));
			fold(assistantTurn({ cache_creation_input_tokens: 0 }));
			// plus one compaction and one tool-result payload
			fold({ type: "system", subtype: "compact_boundary" });
			fold({
				type: "user",
				message: {
					content: [
						{
							type: "tool_result",
							tool_use_id: "t1",
							content: "z".repeat(300),
						},
					],
				},
			});
			const shown = derive(lane);
			expect(shown.turns).toBe(3);

			expect(shown.compactions).toBe(1);
			expect(shown.cacheHitRate).toBeCloseTo(2 / 3, 5);
			// absolute, not a percentage: 3 turns of the mix above
			expect(shown.absoluteTokens).toBeGreaterThan(1000);
			expect(shown.toolResultShare).toBeGreaterThan(0);
		}
	});

	test("consecutive failures count up on failure and reset on success", () => {
		let lane = emptyLaneMetrics("ws-a");
		lane = foldUsage(lane, { ...emptyUsage(), failed: true });
		lane = foldUsage(lane, { ...emptyUsage(), failed: true });
		lane = foldUsage(lane, { ...emptyUsage(), failed: true });
		expect(lane.consecutiveFailures).toBe(3);
		lane = foldUsage(lane, { ...emptyUsage(), failed: false });
		expect(lane.consecutiveFailures).toBe(0);
	});

	test("a lane with no observations reads as zeroes, never as NaN", () => {
		const shown = derive(emptyLaneMetrics("ws-a"));
		expect(shown.absoluteTokens).toBe(0);
		expect(shown.cacheHitRate).toBe(0);
		expect(shown.toolResultShare).toBe(0);
		expect(Number.isNaN(shown.cacheHitRate)).toBe(false);
	});

	test("every lane is listed, sorted, and independently resettable", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.metrics.record("ws-b", { ...emptyUsage(), outputTokens: 5 });
			await bb.metrics.record("ws-a", { ...emptyUsage(), outputTokens: 7 });
			const lanes = await bb.metrics.list();
			expect(lanes.map((lane) => lane.workspot)).toEqual(["ws-a", "ws-b"]);

			await bb.metrics.reset("ws-a");
			const after = await bb.metrics.list();
			expect(after.find((lane) => lane.workspot === "ws-a")?.outputTokens).toBe(
				0,
			);
			expect(after.find((lane) => lane.workspot === "ws-b")?.outputTokens).toBe(
				5,
			);
		} finally {
			await cleanup();
		}
	});
});
