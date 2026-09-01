import { describe, expect, test } from "bun:test";
import { envelopes } from "./envelopes";

const all = [
	envelopes.missingDependency("g-1", ["g-ghost"]),
	envelopes.deadDependency("g-1", "planned", [
		{ id: "g-dead", status: "stale_done" },
	]),
	envelopes.orphanTask("ws-a", "g-ghost"),
	envelopes.blockedWorkspot("ws-a", "g-1", "stale_done"),
	envelopes.checkpointWithoutPolicy("cp-1", "ws-a"),
	envelopes.checkpointAwaitingReview("cp-2"),
	envelopes.staleQueueEntries(["g-old"]),
	envelopes.noIdleWorkspot(3),
	envelopes.dispatchSuggestion("g-1", "ws-a"),
	envelopes.concurrencyCap(2, 4),
	envelopes.metricCacheMiss("ws-a", 0.2),
	envelopes.metricToolBloat("ws-a", 0.61),
	envelopes.metricSuspend("ws-a", 3),
];

describe("SBAR envelopes (TF-0081 / TF-0082)", () => {
	test("every builder names an action, a consequence, and a recommendation that is not a question", () => {
		expect(all).toHaveLength(13);
		for (const env of all) {
			expect(env.action.label.trim().length).toBeGreaterThan(0);
			expect(env.sbar.assessment.trim().length).toBeGreaterThan(0);
			expect(env.sbar.recommendation.trim().length).toBeGreaterThan(0);
			expect(/[?？]$/.test(env.sbar.recommendation.trim())).toBe(false);
		}
	});

	test("the human channel stays binary: envelopes carry no intermediate alarm grade", () => {
		for (const env of all) {
			expect("alarmLevel" in env).toBe(false);
			expect("likelihood" in env).toBe(false);
		}
	});
});
