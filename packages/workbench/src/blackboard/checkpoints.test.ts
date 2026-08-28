import { describe, expect, test } from "bun:test";
import { makeTempWorkbench } from "../test/fixtures";
import type { Checkpoint, CheckpointLifecycle } from "../types/checkpoint";

function sampleCheckpoint(
	id: string,
	lifecycle: CheckpointLifecycle,
): Checkpoint {
	return {
		id,
		goal: "g-1",
		workspot: "ws-a",
		timestamp: new Date().toISOString(),
		lifecycle,
		assertion: "bun test 全绿",
		artifacts: [],
		unblocks: [],
	};
}

describe("checkpoints blackboard API", () => {
	test("save + zone scans", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.checkpoints.save(sampleCheckpoint("cp-1", "pending"), "staging");
			await bb.checkpoints.save(
				sampleCheckpoint("cp-2", "verified"),
				"verified",
			);

			expect(
				(await bb.checkpoints.scanZone("staging")).map((cp) => cp.id),
			).toEqual(["cp-1"]);
			const all = await bb.checkpoints.scanAll();
			expect(all.staging.map((cp) => cp.id)).toEqual(["cp-1"]);
			expect(all.verified.map((cp) => cp.id)).toEqual(["cp-2"]);
			expect(all.failed).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("move relocates the file, leaves an event, and empties the source zone", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.checkpoints.save(sampleCheckpoint("cp-1", "pending"), "staging");
			await bb.checkpoints.move("cp-1", "staging", "verified");

			expect(await bb.checkpoints.scanZone("staging")).toEqual([]);
			const verified = await bb.checkpoints.scanZone("verified");
			expect(verified.map((cp) => cp.id)).toEqual(["cp-1"]);

			const events = await bb.events.query({ type: "checkpoint_moved" });
			expect(events).toHaveLength(1);
			expect(events[0]?.payload).toEqual({
				cpId: "cp-1",
				from: "staging",
				to: "verified",
			});
		} finally {
			await cleanup();
		}
	});

	test("move fails when the checkpoint is not in the source zone", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			expect(
				bb.checkpoints.move("cp-nope", "staging", "verified"),
			).rejects.toThrow(/not found in staging/);
		} finally {
			await cleanup();
		}
	});

	test("getForGoal finds checkpoints across zones", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.checkpoints.save(sampleCheckpoint("cp-1", "pending"), "staging");
			await bb.checkpoints.save(
				sampleCheckpoint("cp-2", "verified"),
				"verified",
			);
			await bb.checkpoints.save(
				{ ...sampleCheckpoint("cp-3", "failed"), goal: "g-2" },
				"failed",
			);

			const mine = await bb.checkpoints.getForGoal("g-1");
			expect(mine.map((cp) => cp.id)).toEqual(["cp-1", "cp-2"]);
		} finally {
			await cleanup();
		}
	});
});
