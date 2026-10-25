import { expect, spyOn, test } from "bun:test";
import { runOnce } from "../runtime";
import { seedArtifactUse } from "../test/artifact-use-fixture";
import { consumeArtifact } from "./consume";
import { revalidateArtifact } from "./revalidate";
import { listArtifactReviews } from "./status";

test("failed effect leaves a started receipt and no applied or completion claim", async () => {
	const ws = await seedArtifactUse();
	try {
		const update = spyOn(ws.bb.interfaces, "updateEntry").mockRejectedValue(
			new Error("injected effect failure"),
		);
		try {
			await runOnce(ws.bb);
		} finally {
			update.mockRestore();
		}
		const failed = (await ws.bb.checkpoints.scanZone("failed"))[0]!;
		expect(failed).toMatchObject({
			lifecycle: "failed",
			artifactConsumption: { state: "started", evidenceCheckpointId: "cp" },
		});
		expect(failed.rollback?.context?.acceptance).toBeDefined();
		expect((await ws.bb.interfaces.getEntry("acceptance"))?.publishedBy).toBe(
			"before",
		);
		expect(
			await ws.bb.events.query({ type: "checkpoint_applied" }),
		).toHaveLength(0);
		await runOnce(ws.bb);
		expect((await ws.bb.goals.get(ws.goalId))?.status).toBe("in_progress");
		expect((await listArtifactReviews(ws.bb))[0]?.status).not.toBe("current");
		const later = await revalidateArtifact(ws.bb, failed.id);
		expect(later.verificationResult?.status).toBe("passed");
		expect((await listArtifactReviews(ws.bb))[0]?.status).toBe("failed");
	} finally {
		await ws.cleanup();
	}
});

test("restart with a started receipt stops automatic and explicit effect replay", async () => {
	const ws = await seedArtifactUse();
	try {
		// Simulate an interrupted process by persisting its receipt, then reload
		// that checkpoint through the ordinary runtime and explicit consumer.
		const cp = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		const { checkArtifactUse } = await import("./use-guard");
		const decision = await checkArtifactUse(ws.bb, cp, cp.id);
		expect(decision.ok).toBe(true);
		await ws.bb.checkpoints.save(
			{ ...cp, artifactConsumption: decision.receipt },
			"verified",
		);
		await runOnce(ws.bb);
		expect((await consumeArtifact(ws.bb, "cp", "cp")).ok).toBe(false);
		expect((await ws.bb.interfaces.getEntry("acceptance"))?.publishedBy).toBe(
			"before",
		);
		expect(
			await ws.bb.events.query({ type: "checkpoint_applied" }),
		).toHaveLength(0);
		expect((await ws.bb.goals.get(ws.goalId))?.status).toBe("in_progress");
		expect((await listArtifactReviews(ws.bb))[0]?.status).toBe("unknown");
	} finally {
		await ws.cleanup();
	}
});
