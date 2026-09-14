import { describe, expect, test } from "bun:test";
import { mkGoal, mkWorkspot } from "../test/automaton-fixtures";
import type { SchedulerState } from "./tick";
import { tick } from "./tick";

function stateWith(partial: Partial<SchedulerState>): SchedulerState {
	return {
		policy: "auto",
		queue: [],
		goals: [],
		workspots: [],
		maxConcurrentWorkspots: 2,
		...partial,
	};
}

describe("scheduler tick", () => {
	test("manual policy is always a noop", () => {
		const state = stateWith({
			policy: "manual",
			queue: ["g-1"],
			goals: [mkGoal({ id: "g-1", status: "ready" })],
			workspots: [mkWorkspot("ws-a", "idle", "g-1")],
		});
		expect(tick(state)).toEqual([]);
	});

	test("auto pairs ready goals with idle workspots in order", () => {
		const state = stateWith({
			queue: ["g-1", "g-2"],
			goals: [
				mkGoal({ id: "g-1", status: "ready" }),
				mkGoal({ id: "g-2", status: "ready" }),
			],
			workspots: [
				mkWorkspot("ws-a", "idle", "g-0"),
				mkWorkspot("ws-b", "idle", "g-0"),
			],
		});
		expect(tick(state)).toEqual([
			{ type: "dispatch", goalId: "g-1", workspotId: "ws-a" },
			{ type: "dispatch", goalId: "g-2", workspotId: "ws-b" },
		]);
	});

	test("auto respects the concurrency cap", () => {
		const state = stateWith({
			maxConcurrentWorkspots: 2,
			queue: ["g-1", "g-2"],
			goals: [
				mkGoal({ id: "g-1", status: "ready" }),
				mkGoal({ id: "g-2", status: "ready" }),
			],
			workspots: [
				mkWorkspot("ws-busy", "active", "g-9"),
				mkWorkspot("ws-a", "idle", "g-0"),
				mkWorkspot("ws-b", "idle", "g-0"),
			],
		});
		const decisions = tick(state);
		expect(decisions).toEqual([
			{ type: "dispatch", goalId: "g-1", workspotId: "ws-a" },
		]);
	});

	test("no idle workspots with a full cap warns in auto", () => {
		const state = stateWith({
			queue: ["g-1"],
			goals: [mkGoal({ id: "g-1", status: "ready" })],
			workspots: [mkWorkspot("ws-a", "active", "g-9")],
			maxConcurrentWorkspots: 1,
		});
		const decisions = tick(state);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({
			type: "notify_human",
			severity: "warning",
		});
	});

	test("semi-auto suggests instead of dispatching", () => {
		const state = stateWith({
			policy: "semi-auto",
			queue: ["g-1"],
			goals: [mkGoal({ id: "g-1", status: "ready" })],
			workspots: [mkWorkspot("ws-a", "idle", "g-0")],
		});
		const decisions = tick(state);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({
			type: "notify_human",
			severity: "info",
		});
	});

	test("stale queue entries are flagged in any non-manual policy", () => {
		const state = stateWith({
			policy: "semi-auto",
			queue: ["g-ghost"],
			goals: [],
			workspots: [],
		});
		const decisions = tick(state);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({
			type: "notify_human",
			severity: "warning",
		});
	});

	test("empty queue yields nothing", () => {
		expect(tick(stateWith({ policy: "auto" }))).toEqual([]);
	});
});
