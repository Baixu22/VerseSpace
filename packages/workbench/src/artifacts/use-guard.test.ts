import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashPathClaim } from "../blackboard/footprint-sample";
import { hashText } from "../hash";
import { runOnce } from "../runtime";
import { seedArtifactUse as seed } from "../test/artifact-use-fixture";
import { consumeArtifact } from "./consume";
import { revalidateArtifact } from "./revalidate";

test("runtime applies a proven artifact once and records the exact consumed evidence and digests", async () => {
	const ws = await seed();
	try {
		await runOnce(ws.bb);
		const applied = (await ws.bb.checkpoints.scanZone("verified")).find(
			(cp) => cp.id === "cp",
		)!;
		expect(applied.lifecycle).toBe("applied");
		expect(applied.artifactConsumption).toMatchObject({
			evidenceCheckpointId: "cp",
			state: "applied",
			mode: "recorded-inputs-v1",
			artifactHash: hashText("v1"),
			reportHash: hashText(
				await readFile(join(ws.projectDir, "report.json"), "utf8"),
			),
			manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect((await ws.bb.interfaces.getEntry("acceptance"))?.publishedBy).toBe(
			"after",
		);
		await runOnce(ws.bb);
		expect((await ws.bb.goals.get(ws.goalId))?.status).toBe("done");
		const duplicate = await consumeArtifact(ws.bb, "cp", "cp");
		expect(duplicate.ok).toBe(false);
		expect(duplicate.reason).toContain("重复");
		expect(
			await ws.bb.events.query({ type: "checkpoint_applied" }),
		).toHaveLength(1);
		expect(
			(await ws.bb.checkpoints.scanZone("verified")).find(
				(cp) => cp.id === "cp",
			),
		).toEqual(applied);
	} finally {
		await ws.cleanup();
	}
}, 60_000);

test("stale input and reread cannot consume effects; a fresh recheck permits explicit CLI consumption once", async () => {
	const ws = await seed();
	try {
		await writeFile(join(ws.projectDir, "api.txt"), "v2");
		await ws.bb.sessions.recordActivity("writer", {
			activity: "reread",
			agent: "writer",
			used: [await hashPathClaim(ws.projectDir, "api.txt")],
			generated: [],
		});
		await runOnce(ws.bb);
		expect((await ws.bb.interfaces.getEntry("acceptance"))?.publishedBy).toBe(
			"before",
		);
		expect((await ws.bb.goals.get(ws.goalId))?.status).toBe("in_progress");
		expect(
			await ws.bb.events.query({ type: "checkpoint_applied" }),
		).toHaveLength(0);
		const rejection = (
			await ws.bb.events.query({ type: "artifact_use_rejected" })
		)[0]!;
		expect(rejection.payload).toMatchObject({
			ok: false,
			rootId: "cp",
			evidenceId: "cp",
			refs: expect.arrayContaining(["cp"]),
		});
		await runOnce(ws.bb);
		expect(
			await ws.bb.events.query({ type: "artifact_use_rejected" }),
		).toHaveLength(1);
		const failed = await revalidateArtifact(ws.bb, "cp");
		expect((await consumeArtifact(ws.bb, "cp", failed.id)).ok).toBe(false);
		await writeFile(join(ws.projectDir, "consumer.txt"), "*");
		const fresh = await revalidateArtifact(ws.bb, failed.id);
		expect(fresh.verificationResult?.status).toBe("passed");
		expect(fresh.blackboardEffects?.update).toHaveLength(0);
		expect((await consumeArtifact(ws.bb, "cp", "cp")).ok).toBe(false);
		const cli = spawnSync(
			process.execPath,
			[
				resolve(import.meta.dir, "../index.ts"),
				"checkpoint",
				"consume",
				"cp",
				"--evidence",
				fresh.id,
				"--json",
			],
			{ cwd: ws.projectDir, encoding: "utf8" },
		);
		expect(cli.status).toBe(0);
		expect(JSON.parse(cli.stdout)).toMatchObject({
			ok: true,
			rootId: "cp",
			evidenceId: fresh.id,
		});
		expect((await ws.bb.interfaces.getEntry("acceptance"))?.publishedBy).toBe(
			"after",
		);
		await runOnce(ws.bb);
		expect((await ws.bb.goals.get(ws.goalId))?.status).toBe("done");
		expect(
			await ws.bb.events.query({ type: "checkpoint_applied" }),
		).toHaveLength(1);
		expect((await consumeArtifact(ws.bb, "cp", fresh.id)).ok).toBe(false);
	} finally {
		await ws.cleanup();
	}
}, 60_000);

test.each([
	"sampled",
	"unknown",
] as const)("runtime rejects %s historical input receipts without applying or completing", async (mode) => {
	const ws = await seed(mode);
	try {
		await runOnce(ws.bb);
		expect((await ws.bb.interfaces.getEntry("acceptance"))?.publishedBy).toBe(
			"before",
		);
		expect((await ws.bb.goals.get(ws.goalId))?.status).toBe("in_progress");
		expect(
			await ws.bb.events.query({ type: "checkpoint_applied" }),
		).toHaveLength(0);
		expect(
			(await ws.bb.events.query({ type: "artifact_use_rejected" }))[0]?.payload,
		).toMatchObject({ ok: false, reason: expect.stringContaining("来源") });
	} finally {
		await ws.cleanup();
	}
});

test("changed report or artifact rejects consumption; legacy declared checks retain an explicit weaker receipt", async () => {
	const ws = await seed();
	try {
		await writeFile(join(ws.projectDir, "report.json"), "{}");
		await runOnce(ws.bb);
		expect(
			await ws.bb.events.query({ type: "checkpoint_applied" }),
		).toHaveLength(0);
		const fresh = await revalidateArtifact(ws.bb, "cp");
		await writeFile(join(ws.projectDir, "consumer.txt"), "changed");
		expect((await consumeArtifact(ws.bb, "cp", fresh.id)).ok).toBe(false);
		expect((await ws.bb.interfaces.getEntry("acceptance"))?.publishedBy).toBe(
			"before",
		);
	} finally {
		await ws.cleanup();
	}
	const legacy = await seed("legacy");
	try {
		await runOnce(legacy.bb);
		expect(
			(await legacy.bb.checkpoints.scanZone("verified"))[0]?.artifactConsumption
				?.mode,
		).toBe("legacy-declared-scope");
	} finally {
		await legacy.cleanup();
	}
});
