import { describe, expect, test } from "bun:test";
import {
	mkCheckpoint,
	mkGoal,
	mkWorkspot,
	snapshotWith,
} from "../test/automaton-fixtures";
import { evaluate } from "./evaluator";

describe("evaluator", () => {
	test("composes goal, checkpoint, and workspot transitions in stable order", () => {
		const snapshot = snapshotWith({
			goals: [
				mkGoal({ id: "g-1", status: "ready" }),
				mkGoal({ id: "g-done", status: "done" }),
			],
			checkpoints: {
				staging: [
					{
						...mkCheckpoint("cp-1", "draft"),
						verification: { strategy: "type-check" },
					},
				],
				verified: [],
				failed: [],
			},
			workspots: [mkWorkspot("ws-a", "active", "g-done")],
		});

		expect(evaluate(snapshot)).toEqual([
			// goals first
			{ type: "enqueue_goal", goalId: "g-1" },
			// then checkpoints
			{ type: "request_verification", cpId: "cp-1" },
			// then workspots
			{
				type: "workspot_status",
				wsId: "ws-a",
				from: "active",
				to: "idle",
				reason: "任务 g-done 已完成，释放工位",
			},
			{ type: "refresh_context", wsId: "ws-a" },
		]);
	});

	test("is idempotent: the same snapshot evaluates to the same transitions", () => {
		const snapshot = snapshotWith({
			goals: [
				mkGoal({ id: "g-1" }),
				mkGoal({ id: "g-2", status: "ready", dependsOn: ["g-1"] }),
			],
			checkpoints: {
				staging: [mkCheckpoint("cp-1", "awaiting_review")],
				verified: [mkCheckpoint("cp-2", "verified")],
				failed: [],
			},
			workspots: [mkWorkspot("ws-a", "active", "g-2")],
		});
		expect(evaluate(snapshot)).toEqual(evaluate(snapshot));
	});

	test("an already-consistent snapshot yields no transitions", () => {
		const snapshot = snapshotWith({
			goals: [
				mkGoal({ id: "g-1", status: "done" }),
				mkGoal({ id: "g-2", status: "ready", dependsOn: ["g-1"] }),
			],
			executionQueue: ["g-2"],
		});
		// g-1 done satisfies g-2's dependency; g-2 stays ready; queue holds g-2
		expect(evaluate(snapshot)).toEqual([]);
	});
});
