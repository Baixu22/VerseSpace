import { describe, expect, test } from "bun:test";
import { mkGoal, mkWorkspot, snapshotWith } from "./fixtures";
import { evaluateWorkspots } from "./workspot-machine";

describe("workspot machine", () => {
	test("active workspot is released when its task is done", () => {
		const snapshot = snapshotWith({
			goals: [mkGoal({ id: "g-1", status: "done" })],
			workspots: [mkWorkspot("ws-a", "active", "g-1")],
		});
		expect(evaluateWorkspots(snapshot)).toEqual([
			{
				type: "workspot_status",
				wsId: "ws-a",
				from: "active",
				to: "idle",
				reason: "任务 g-1 已完成，释放工位",
			},
			{ type: "refresh_context", wsId: "ws-a" },
		]);
	});

	test("borrowed workspot follows currentTask for release", () => {
		const snapshot = snapshotWith({
			goals: [mkGoal({ id: "g-1", status: "done" })],
			workspots: [
				mkWorkspot("ws-b", "active", "g-main", {
					currentTask: "g-1",
					binding: "borrowed",
				}),
			],
		});
		expect(evaluateWorkspots(snapshot)).toEqual([
			{
				type: "workspot_status",
				wsId: "ws-b",
				from: "active",
				to: "idle",
				reason: "任务 g-1 已完成，释放工位",
			},
			{ type: "refresh_context", wsId: "ws-b" },
		]);
	});

	test("active workspot is blocked when its task went stale", () => {
		const snapshot = snapshotWith({
			goals: [mkGoal({ id: "g-1", status: "stale_done" })],
			workspots: [mkWorkspot("ws-a", "active", "g-1")],
		});
		const transitions = evaluateWorkspots(snapshot);
		expect(transitions).toEqual([
			{
				type: "workspot_status",
				wsId: "ws-a",
				from: "active",
				to: "blocked",
				reason: "任务 g-1 已失效（stale_done），需人工重新指派",
			},
			{
				type: "notify_human",
				message: "工位 ws-a 被阻塞：任务 g-1 stale_done",
				severity: "warning",
			},
		]);
	});

	test("active workspot pointing at a missing goal raises an error notification", () => {
		const snapshot = snapshotWith({
			goals: [],
			workspots: [mkWorkspot("ws-a", "active", "g-ghost")],
		});
		expect(evaluateWorkspots(snapshot)).toEqual([
			{
				type: "notify_human",
				message: "工位 ws-a 指向的目标 g-ghost 不存在",
				severity: "error",
			},
		]);
	});

	test("non-active workspots yield nothing", () => {
		const snapshot = snapshotWith({
			goals: [mkGoal({ id: "g-1", status: "done" })],
			workspots: [
				mkWorkspot("ws-idle", "idle", "g-1"),
				mkWorkspot("ws-blocked", "blocked", "g-1"),
			],
		});
		expect(evaluateWorkspots(snapshot)).toEqual([]);
	});
});
