import { expect, test } from "bun:test";
import { hashText } from "../hash";
import { runOnce } from "../runtime";
import { seedArtifactUse } from "../test/artifact-use-fixture";

test("changing read selection after verification cannot consume the same file hashes as old evidence", async () => {
	const ws = await seedArtifactUse();
	try {
		const cp = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		await ws.bb.checkpoints.save(
			{
				...cp,
				artifact: {
					...cp.artifact!,
					inputRecords: [
						{ path: "api.txt", writerId: "writer", footprintSeq: 999 },
					],
				},
			},
			"verified",
		);
		await runOnce(ws.bb);
		expect(
			await ws.bb.events.query({ type: "checkpoint_applied" }),
		).toHaveLength(0);
		expect((await ws.bb.interfaces.getEntry("acceptance"))?.publishedBy).toBe(
			"before",
		);
	} finally {
		await ws.cleanup();
	}
});

test("modified historical receipt is rejected against original footprint even when declared paths match", async () => {
	const ws = await seedArtifactUse();
	try {
		const cp = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		const origin = structuredClone(cp.artifactInputOrigin!);
		origin.reads[0]!.contentHash = hashText("forged");
		await ws.bb.checkpoints.save(
			{ ...cp, artifactInputOrigin: origin },
			"verified",
		);
		await runOnce(ws.bb);
		expect(
			await ws.bb.events.query({ type: "checkpoint_applied" }),
		).toHaveLength(0);
		expect(
			(await ws.bb.events.query({ type: "artifact_use_rejected" }))[0]?.payload,
		).toMatchObject({ reason: expect.stringContaining("原始足迹") });
	} finally {
		await ws.cleanup();
	}
});
