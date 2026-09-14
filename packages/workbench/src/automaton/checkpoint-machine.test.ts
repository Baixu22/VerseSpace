import { describe, expect, test } from "bun:test";
import { mkCheckpoint, snapshotWith } from "../test/automaton-fixtures";
import { evaluateCheckpoints } from "./checkpoint-machine";

describe("checkpoint machine", () => {
	test("draft with a verification strategy requests verification", () => {
		const snapshot = snapshotWith({
			checkpoints: {
				staging: [
					{
						...mkCheckpoint("cp-1", "draft"),
						verification: { strategy: "test", command: "bun test" },
					},
				],
				verified: [],
				failed: [],
			},
		});
		expect(evaluateCheckpoints(snapshot)).toEqual([
			{ type: "request_verification", cpId: "cp-1" },
		]);
	});

	test("draft without a verification strategy warns and stays draft", () => {
		const snapshot = snapshotWith({
			checkpoints: {
				staging: [mkCheckpoint("cp-1", "draft")],
				verified: [],
				failed: [],
			},
		});
		const transitions = evaluateCheckpoints(snapshot);
		expect(transitions).toHaveLength(1);
		expect(transitions[0]).toMatchObject({
			type: "notify_human",
			severity: "warning",
		});
	});

	test("pending checkpoints are owned by the verifier and yield nothing", () => {
		const snapshot = snapshotWith({
			checkpoints: {
				staging: [mkCheckpoint("cp-1", "pending")],
				verified: [],
				failed: [],
			},
		});
		expect(evaluateCheckpoints(snapshot)).toEqual([]);
	});

	test("awaiting_review emits an info notification", () => {
		const snapshot = snapshotWith({
			checkpoints: {
				staging: [mkCheckpoint("cp-1", "awaiting_review")],
				verified: [],
				failed: [],
			},
		});
		const transitions = evaluateCheckpoints(snapshot);
		expect(transitions).toHaveLength(1);
		expect(transitions[0]).toMatchObject({
			type: "notify_human",
			severity: "info",
		});
	});

	test("verified checkpoints are applied", () => {
		const snapshot = snapshotWith({
			checkpoints: {
				staging: [],
				verified: [mkCheckpoint("cp-1", "verified")],
				failed: [],
			},
		});
		expect(evaluateCheckpoints(snapshot)).toEqual([
			{
				type: "checkpoint_lifecycle",
				cpId: "cp-1",
				from: "verified",
				to: "applied",
			},
		]);
	});

	test("already-applied checkpoints in the verified zone yield nothing", () => {
		const snapshot = snapshotWith({
			checkpoints: {
				staging: [],
				verified: [mkCheckpoint("cp-1", "applied")],
				failed: [],
			},
		});
		expect(evaluateCheckpoints(snapshot)).toEqual([]);
	});

	test("failed checkpoints are silent for the automaton", () => {
		const snapshot = snapshotWith({
			checkpoints: {
				staging: [],
				verified: [],
				failed: [
					mkCheckpoint("cp-1", "failed"),
					mkCheckpoint("cp-2", "rejected"),
				],
			},
		});
		expect(evaluateCheckpoints(snapshot)).toEqual([]);
	});
});
