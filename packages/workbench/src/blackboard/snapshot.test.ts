import { describe, expect, test } from "bun:test";
import { makeTempWorkbench, type TempWorkbench } from "../test/fixtures";

describe("getWorldSnapshot", () => {
	test("aggregates goals, checkpoints, interfaces, workspots, and queue", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		try {
			const { bb } = ws;
			const goal = await bb.goals.add({ title: "实现数据层" });
			await bb.checkpoints.save(
				{
					id: "cp-1",
					goal: goal.id,
					workspot: "ws-a",
					timestamp: new Date().toISOString(),
					lifecycle: "pending",
					assertion: "tests green",
					artifacts: [],
					unblocks: [],
				},
				"staging",
			);
			await bb.state.workspots.save({
				id: "ws-a",
				branch: "ws/ws-a",
				worktreePath: "../ws-a",
				primaryTask: goal.id,
				binding: "primary",
				status: "active",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			await bb.state.queue.enqueue(goal.id);

			const snapshot = await bb.snapshot();
			expect(snapshot.goals.map((g) => g.id)).toEqual([goal.id]);
			expect(snapshot.checkpoints.staging).toHaveLength(1);
			expect(snapshot.checkpoints.verified).toEqual([]);
			expect(snapshot.interfaces).toEqual([]);
			expect(snapshot.workspots.map((w) => w.id)).toEqual(["ws-a"]);
			expect(snapshot.executionQueue).toEqual([goal.id]);
		} finally {
			await ws.cleanup();
		}
	});

	test("empty workspace yields an empty snapshot", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		try {
			const snapshot = await ws.bb.snapshot();
			expect(snapshot).toEqual({
				goals: [],
				checkpoints: { staging: [], verified: [], failed: [] },
				interfaces: [],
				workspots: [],
				executionQueue: [],
			});
		} finally {
			await ws.cleanup();
		}
	});
});
