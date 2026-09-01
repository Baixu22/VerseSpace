import { describe, expect, test } from "bun:test";
import { makeTempWorkbench } from "../test/fixtures";
import {
	admitDispatch,
	explainWip,
	joinFlow,
	littleLawWip,
	MIN_SAMPLES,
	observeFlow,
} from "./wip";

/** Append an event with an explicit timestamp (the log is append-only). */
async function stamp(
	bb: Awaited<ReturnType<typeof makeTempWorkbench>>["bb"],
	type: string,
	payload: unknown,
	minutesAgo: number,
): Promise<void> {
	await bb.events.append({
		timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
		source: "test",
		type,
		payload,
	});
}

describe("Little's Law (TF-0083)", () => {
	test("WIP is throughput times residence time, rounded up", () => {
		// 2 items/hour × 90 minutes = 3 items in the system
		expect(littleLawWip(2, 90)).toBe(3);
		// 0.5/hour × 30 minutes = 0.25 → at least one lane may run
		expect(littleLawWip(0.5, 30)).toBe(1);
		// no throughput ⇒ nothing to derive; never a limit of zero
		expect(littleLawWip(0, 30)).toBe(1);
	});

	test("the flow join measures from the last dispatch of a goal", () => {
		const now = Date.parse("2026-01-02T00:00:00.000Z");
		const { samples } = joinFlow(
			[
				{ goalId: "g-1", at: now - 600 * 60_000 },
				{ goalId: "g-1", at: now - 60 * 60_000 },
			],
			[{ goalId: "g-1", at: now }],
			now,
		);
		expect(samples).toHaveLength(1);
		expect(samples[0]?.residenceMinutes).toBeCloseTo(60, 5);
	});

	test("a lane abandoned for longer than the cap is not a slow lane", () => {
		const now = Date.parse("2026-01-02T00:00:00.000Z");
		const { samples } = joinFlow(
			[{ goalId: "g-1", at: now - 40 * 60 * 60_000 }],
			[{ goalId: "g-1", at: now }],
			now,
		);
		expect(samples).toHaveLength(0);
	});
});

describe("WIP derivation and admission (TF-0083)", () => {
	test("with no history the limit is the physical bound and says so", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.state.workspots.save({
				id: "ws-a",
				branch: "ws/ws-a",
				worktreePath: "worktrees/ws-a",
				primaryTask: "g-0",
				binding: "primary",
				status: "idle",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			const flow = await observeFlow(bb);
			expect(flow.basis).toBe("insufficient-history");
			expect(flow.wipLimit).toBe(1); // one workspot exists
			expect(explainWip(flow)).toContain("不足");
		} finally {
			await cleanup();
		}
	});

	test("three completions derive a limit instead of a guess", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			for (const [i, minutes] of [30, 60, 90].entries()) {
				await stamp(bb, "goal_dispatched", { goalId: `g-${i}` }, 200);
				await stamp(
					bb,
					"goal_status",
					{ goalId: `g-${i}`, to: "done" },
					minutes,
				);
			}
			const flow = await observeFlow(bb);
			expect(flow.completed).toBe(3);
			expect(flow.basis).toBe("little-law");
			expect(flow.meanResidenceMinutes).toBeGreaterThan(0);
			expect(flow.throughputPerHour).toBeGreaterThan(0);
			expect(flow.wipLimit).toBe(
				littleLawWip(flow.throughputPerHour, flow.meanResidenceMinutes),
			);
			expect(explainWip(flow)).toContain("Little 定律");
		} finally {
			await cleanup();
		}
	});

	test("admission refuses once the pool is empty, with the drum's numbers", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			// history thin on purpose: limit = physical bound = 2 workspots
			await bb.state.workspots.save({
				id: "ws-a",
				branch: "ws/ws-a",
				worktreePath: "worktrees/ws-a",
				primaryTask: "g-1",
				binding: "primary",
				status: "active",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			await bb.state.workspots.save({
				id: "ws-b",
				branch: "ws/ws-b",
				worktreePath: "worktrees/ws-b",
				primaryTask: "g-2",
				binding: "primary",
				status: "active",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			const flow = await observeFlow(bb);
			expect(flow.inFlight).toBe(2);
			expect(flow.tokensFree).toBe(0);

			const refused = await admitDispatch(bb);
			expect(refused.allowed).toBe(false);
			expect(refused.reason).toContain("复核");
			expect(refused.reason).toContain("--force");

			// the override is explicit and available, not hidden
			const forced = await admitDispatch(bb, { force: true });
			expect(forced.allowed).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("the shared unreviewed backlog is one number, not one per lane", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const goal = await bb.goals.add({ title: "待复核的目标" });
			await bb.checkpoints.save(
				{
					id: "cp-1",
					goal: goal.id,
					workspot: "ws-a",
					timestamp: new Date().toISOString(),
					assertion: "待复核",
					lifecycle: "awaiting_review",
					artifacts: [],
					unblocks: [],
					blackboardEffects: { publish: [], update: [] },
				},
				"staging",
			);
			const flow = await observeFlow(bb);
			expect(flow.unreviewedBacklog).toBe(1);
			expect(flow.inFlight).toBe(1);
		} finally {
			await cleanup();
		}
	});

	test("MIN_SAMPLES is the threshold between a guess and a derivation", () => {
		expect(MIN_SAMPLES).toBeGreaterThan(1);
	});
});
