import { describe, expect, test } from "bun:test";
import type { Transition } from "../types/transitions";
import {
	mkCheckpoint,
	mkEntry,
	mkGoal,
	mkWorkspot,
	snapshotWith,
} from "./fixtures";
import { evaluateGoals } from "./goal-machine";

describe("goal machine", () => {
	test("planned goal with no dependencies becomes ready", () => {
		const snapshot = snapshotWith({ goals: [mkGoal({ id: "g-1" })] });
		expect(evaluateGoals(snapshot)).toEqual([
			{
				type: "goal_status",
				goalId: "g-1",
				from: "planned",
				to: "ready",
				reason: "所有依赖已完成",
			},
		]);
	});

	test("planned goal waits while a dependency is not done", () => {
		const snapshot = snapshotWith({
			goals: [
				mkGoal({ id: "g-1", dependsOn: ["g-2"] }),
				mkGoal({ id: "g-2", status: "in_progress" }),
			],
		});
		expect(evaluateGoals(snapshot)).toEqual([]);
	});

	test("planned goal with a missing dependency emits an error notification", () => {
		const snapshot = snapshotWith({
			goals: [mkGoal({ id: "g-1", dependsOn: ["g-ghost"] })],
		});
		expect(evaluateGoals(snapshot)).toEqual([
			{
				type: "notify_human",
				message: "目标 g-1 依赖的目标不存在：g-ghost",
				severity: "error",
			},
		]);
	});

	test("planned goal blocked by a stale dependency emits a warning", () => {
		const snapshot = snapshotWith({
			goals: [
				mkGoal({ id: "g-1", dependsOn: ["g-2"] }),
				mkGoal({ id: "g-2", status: "stale_done" }),
			],
		});
		const transitions = evaluateGoals(snapshot);
		expect(transitions).toHaveLength(1);
		expect(transitions[0]).toMatchObject({
			type: "notify_human",
			severity: "warning",
		});
	});

	test("ready goal starts when a workspot is active on it (primary or borrowed)", () => {
		const startTransition: Transition = {
			type: "goal_status",
			goalId: "g-1",
			from: "ready",
			to: "in_progress",
			reason: "工位已开始施工",
		};

		const primary = snapshotWith({
			goals: [mkGoal({ id: "g-1", status: "ready" })],
			workspots: [mkWorkspot("ws-a", "active", "g-1")],
		});
		expect(evaluateGoals(primary)).toEqual([
			startTransition,
			{ type: "enqueue_goal", goalId: "g-1" },
		]);

		const borrowed = snapshotWith({
			goals: [mkGoal({ id: "g-1", status: "ready" })],
			workspots: [
				mkWorkspot("ws-b", "active", "g-other", {
					currentTask: "g-1",
					binding: "borrowed",
				}),
			],
		});
		expect(evaluateGoals(borrowed)).toEqual([
			startTransition,
			{ type: "enqueue_goal", goalId: "g-1" },
		]);
	});

	test("ready goal without an active workspot only enqueues", () => {
		const snapshot = snapshotWith({
			goals: [mkGoal({ id: "g-1", status: "ready" })],
		});
		expect(evaluateGoals(snapshot)).toEqual([
			{ type: "enqueue_goal", goalId: "g-1" },
		]);
	});

	test("ready goal already in the queue yields nothing", () => {
		const snapshot = snapshotWith({
			goals: [mkGoal({ id: "g-1", status: "ready" })],
			executionQueue: ["g-1"],
		});
		expect(evaluateGoals(snapshot)).toEqual([]);
	});

	test("in_progress goal completes on a verified checkpoint", () => {
		const snapshot = snapshotWith({
			goals: [mkGoal({ id: "g-1", status: "in_progress" })],
			checkpoints: {
				staging: [mkCheckpoint("cp-0", "pending", "g-1")],
				verified: [mkCheckpoint("cp-1", "verified", "g-1")],
				failed: [],
			},
		});
		expect(evaluateGoals(snapshot)).toEqual([
			{
				type: "goal_status",
				goalId: "g-1",
				from: "in_progress",
				to: "done",
				reason: "存在已验证的 checkpoint",
			},
		]);
	});

	test("in_progress goal ignores staging and failed checkpoints", () => {
		const snapshot = snapshotWith({
			goals: [mkGoal({ id: "g-1", status: "in_progress" })],
			checkpoints: {
				staging: [mkCheckpoint("cp-0", "pending", "g-1")],
				verified: [],
				failed: [mkCheckpoint("cp-2", "failed", "g-1")],
			},
		});
		expect(evaluateGoals(snapshot)).toEqual([]);
	});

	test("done goal goes stale when an anchored interface version increased", () => {
		const snapshot = snapshotWith({
			goals: [
				mkGoal({
					id: "g-1",
					status: "done",
					verifiedAgainst: { interfaces: { "core/api": 1 }, decisions: [] },
				}),
			],
			interfaces: [mkEntry("core/api", 2)],
		});
		expect(evaluateGoals(snapshot)).toEqual([
			{
				type: "mark_stale",
				goalId: "g-1",
				reason: "锚定接口 core/api 已从 v1 漂移到 v2",
			},
		]);
	});

	test("done goal with matching anchor versions is stable", () => {
		const snapshot = snapshotWith({
			goals: [
				mkGoal({
					id: "g-1",
					status: "done",
					verifiedAgainst: { interfaces: { "core/api": 2 }, decisions: [] },
				}),
			],
			interfaces: [mkEntry("core/api", 2)],
		});
		expect(evaluateGoals(snapshot)).toEqual([]);
	});

	test("done goal with an anchor missing from the registry is stable", () => {
		const snapshot = snapshotWith({
			goals: [
				mkGoal({
					id: "g-1",
					status: "done",
					verifiedAgainst: { interfaces: { "legacy/api": 1 }, decisions: [] },
				}),
			],
			interfaces: [],
		});
		expect(evaluateGoals(snapshot)).toEqual([]);
	});

	test("terminal goals (stale_done, cancelled) yield nothing", () => {
		const snapshot = snapshotWith({
			goals: [
				mkGoal({ id: "g-1", status: "stale_done" }),
				mkGoal({ id: "g-2", status: "cancelled" }),
			],
		});
		expect(evaluateGoals(snapshot)).toEqual([]);
	});
});
