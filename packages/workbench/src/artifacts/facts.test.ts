import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	captureReturnedInput,
	hashPathClaim,
} from "../blackboard/footprint-sample";
import { hashText } from "../hash";
import { verifyCheckpoint } from "../runtime/verify-checkpoint";
import { initGitFixture, makeTempWorkbench } from "../test/fixtures";
import { checkpointSchema } from "../types/checkpoint";
import { workspotSchema } from "../types/workspot";
import { selectArtifactInputs } from "./input-origin";
import { revalidateArtifact } from "./revalidate";
import { listArtifactReviews, reconcileArtifacts } from "./status";

async function seed(weak = false) {
	const ws = await makeTempWorkbench();
	initGitFixture(ws.projectDir);
	await writeFile(join(ws.projectDir, "api.txt"), "v1");
	await writeFile(join(ws.projectDir, "consumer.txt"), "v1");
	await writeFile(
		join(ws.projectDir, "check.cjs"),
		`const fs=require("node:fs");const input=fs.readFileSync("api.txt","utf8");const consumer=fs.readFileSync("consumer.txt","utf8");const ok=consumer==="*" || input===consumer;fs.writeFileSync("report.json",JSON.stringify({numTotalTests:1,numPassedTests:+ok,numFailedTests:+!ok,numPendingTests:0,success:ok,testResults:[{assertionResults:[{fullName:"contract",status:ok?"passed":"failed"}]}]}));process.exitCode=ok?0:1;`,
	);
	const goal = await ws.bb.goals.add({ title: "facts" }, "in_progress");
	await ws.bb.state.workspots.save(
		workspotSchema.parse({
			id: "ws",
			branch: "main",
			worktreePath: ws.projectDir,
			status: "active",
			primaryTask: goal.id,
		}),
	);
	await ws.bb.sessions.register("w", "agent");
	const read = weak
		? await hashPathClaim(ws.projectDir, "api.txt")
		: await captureReturnedInput(ws.projectDir, "api.txt", {
				returned: "v1",
				content: "v1",
				selector: { kind: "file" },
			});
	await ws.bb.sessions.recordActivity("w", {
		activity: "read",
		agent: "w",
		used: [read],
		generated: [],
	});
	const cp = checkpointSchema.parse({
		id: "cp",
		goal: goal.id,
		workspot: "ws",
		writerId: "w",
		timestamp: new Date().toISOString(),
		lifecycle: "draft",
		assertion: "facts",
		artifact: {
			path: "consumer.txt",
			inputs: ["api.txt"],
			inputRecords: [{ path: "api.txt", writerId: "w", footprintSeq: 1 }],
		},
		verification: {
			strategy: "test",
			command: `"${process.execPath}" check.cjs`,
			evidence: {
				report: {
					format: "vitest-json",
					path: "report.json",
					expectedTests: ["contract"],
				},
				inputs: ["check.cjs"],
			},
		},
	});
	cp.artifactInputOrigin = await selectArtifactInputs(ws.bb, cp);
	await ws.bb.checkpoints.save(cp, "staging");
	await verifyCheckpoint(ws.bb, "cp", []);
	return ws;
}

test("source, current inputs and latest verification stay independent across reread and revalidation", async () => {
	const ws = await seed();
	try {
		const initial = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		const first = (await listArtifactReviews(ws.bb))[0]!;
		expect(first).toMatchObject({
			status: "current",
			evidenceStrength: "observed-origin-and-scope",
			facts: {
				origin: { strength: "tool-observed" },
				inputs: { status: "matched" },
				verification: {
					checkpointId: "cp",
					result: "passed",
					scope: "satisfied",
					authority: "command",
				},
			},
		});
		await ws.bb.checkpoints.save(
			{ ...initial, lifecycle: "applied" },
			"verified",
		);
		const applied = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		await writeFile(join(ws.projectDir, "api.txt"), "v2");
		await ws.bb.sessions.recordActivity("w", {
			activity: "reread",
			agent: "w",
			used: [await hashPathClaim(ws.projectDir, "api.txt")],
			generated: [],
		});
		await ws.bb.events.append({
			timestamp: new Date().toISOString(),
			source: "threads",
			type: "thread.resume_note_consumed",
			payload: { threadId: "w" },
		});
		const stale = (await listArtifactReviews(ws.bb))[0]!;
		expect(stale).toMatchObject({
			status: "stale",
			facts: {
				origin: { strength: "tool-observed" },
				inputs: { status: "different", changed: ["api.txt"] },
				verification: { checkpointId: "cp", result: "passed" },
			},
		});
		expect(stale.inputOrigin).toEqual(first.inputOrigin);
		const failed = await revalidateArtifact(ws.bb, "cp");
		expect((await listArtifactReviews(ws.bb))[0]).toMatchObject({
			status: "failed",
			facts: { verification: { checkpointId: failed.id, result: "failed" } },
		});
		await writeFile(join(ws.projectDir, "consumer.txt"), "*");
		const current = await revalidateArtifact(ws.bb, failed.id);
		expect((await listArtifactReviews(ws.bb))[0]).toMatchObject({
			status: "current",
			facts: {
				inputs: { status: "matched" },
				verification: { checkpointId: current.id, result: "passed" },
			},
		});
		await writeFile(join(ws.projectDir, "api.txt"), "v3");
		const body = await readFile(join(ws.projectDir, "consumer.txt"), "utf8");
		const noEdit = await revalidateArtifact(ws.bb, current.id);
		expect(noEdit.verificationResult?.status).toBe("passed");
		expect(await readFile(join(ws.projectDir, "consumer.txt"), "utf8")).toBe(
			body,
		);
		const latest = (await listArtifactReviews(ws.bb))[0]!;
		expect(latest.status).toBe("current");
		expect(latest.inputOrigin?.reads[0]?.contentHash).toBe(hashText("v1"));
		expect(latest.facts?.inputs.versions["api.txt"]).toBe(hashText("v3"));
		expect(
			(await ws.bb.checkpoints.scanZone("verified")).find(
				(cp) => cp.id === "cp",
			),
		).toEqual(applied);
		expect(await ws.bb.events.query({ type: "checkpoint_applied" })).toEqual(
			[],
		);
		await reconcileArtifacts(ws.bb);
		const before = await ws.bb.events.query({ type: "artifact_validity" });
		await reconcileArtifacts(ws.bb);
		expect(await ws.bb.events.query({ type: "artifact_validity" })).toEqual(
			before,
		);
	} finally {
		await ws.cleanup();
	}
}, 60_000);

test("explicit sampled or unknown origins cannot be upgraded by an otherwise successful full check", async () => {
	const ws = await seed(true);
	try {
		const cp = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		const sampled = (await listArtifactReviews(ws.bb))[0]!;
		expect(sampled).toMatchObject({
			status: "unknown",
			evidenceStrength: "unknown",
			facts: {
				origin: { strength: "fs-sample" },
				verification: { result: "passed", scope: "satisfied" },
			},
		});
		await ws.bb.checkpoints.save(
			{ ...cp, artifactInputOrigin: undefined },
			"verified",
		);
		expect((await listArtifactReviews(ws.bb))[0]).toMatchObject({
			status: "unknown",
			facts: { origin: { strength: "unknown" } },
		});
		const legacy = {
			...cp,
			artifact: { ...cp.artifact!, inputRecords: undefined },
			artifactInputOrigin: undefined,
		};
		await ws.bb.checkpoints.save(legacy, "verified");
		expect((await listArtifactReviews(ws.bb))[0]?.status).toBe("stale");
		// A real legacy binding predates declarationHash. Removing the selection
		// from a new binding is declaration drift, not a legacy compatibility case.
		await ws.bb.checkpoints.save(
			{
				...legacy,
				artifactOrigin: legacy.artifactOrigin
					? { ...legacy.artifactOrigin, declarationHash: undefined }
					: undefined,
				artifactBinding: legacy.artifactBinding
					? { ...legacy.artifactBinding, declarationHash: undefined }
					: undefined,
			},
			"verified",
		);
		expect((await listArtifactReviews(ws.bb))[0]).toMatchObject({
			status: "current",
			evidenceStrength: "declared-scope",
			facts: { origin: { strength: "declared" } },
		});
	} finally {
		await ws.cleanup();
	}
});

test("pending, review-needed and incomplete report states never expose forged current evidence", async () => {
	const ws = await seed();
	try {
		const cp = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		for (const lifecycle of ["draft", "pending", "awaiting_review"] as const) {
			await ws.bb.checkpoints.save({ ...cp, lifecycle }, "verified");
			expect((await listArtifactReviews(ws.bb))[0]?.status).not.toBe("current");
		}
		await ws.bb.checkpoints.save(
			{
				...cp,
				verificationResult: {
					...cp.verificationResult!,
					evidence: {
						...cp.verificationResult!.evidence!,
						status: "unsatisfied",
					},
				},
			},
			"verified",
		);
		expect((await listArtifactReviews(ws.bb))[0]).toMatchObject({
			status: "unknown",
			facts: { verification: { scope: "unsatisfied" } },
		});
	} finally {
		await ws.cleanup();
	}
});
