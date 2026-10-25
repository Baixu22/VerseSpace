import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	captureReturnedInput,
	hashPathClaim,
} from "../blackboard/footprint-sample";
import { hashText } from "../hash";
import { initGitFixture, makeTempWorkbench } from "../test/fixtures";
import { checkpointSchema } from "../types/checkpoint";
import { workspotSchema } from "../types/workspot";
import { selectArtifactInputs } from "./input-origin";
import { revalidateArtifact } from "./revalidate";
import { captureArtifactSnapshot } from "./snapshot";
import { listArtifactReviews } from "./status";

async function setup() {
	const ws = await makeTempWorkbench();
	initGitFixture(ws.projectDir);
	const goal = await ws.bb.goals.add({ title: "origin" }, "in_progress");
	await ws.bb.state.workspots.save(
		workspotSchema.parse({
			id: "ws",
			branch: "main",
			worktreePath: ws.projectDir,
			status: "active",
			primaryTask: goal.id,
		}),
	);
	await ws.bb.sessions.register("writer", "agent");
	return { ...ws, goalId: goal.id };
}

test("late checkpoint selects immutable v1 reads while current sampling and later reread contain v2", async () => {
	const ws = await setup();
	try {
		const cases = JSON.parse(
			await readFile(
				new URL("../../fixtures/artifact-use/cases.json", import.meta.url),
				"utf8",
			),
		);
		const spec = cases.cases.find(
			(row: { id: string }) => row.id === "late-origin",
		);
		await writeFile(join(ws.projectDir, "api.txt"), spec.input);
		await ws.bb.sessions.recordActivity("writer", {
			activity: "read-v1",
			agent: "subagent",
			used: [
				await captureReturnedInput(ws.projectDir, "api.txt", {
					returned: spec.input,
					content: spec.input,
					selector: { kind: "file" },
				}),
			],
			generated: [],
		});
		const first = (await ws.bb.sessions.footprint("writer"))[0]!;
		await writeFile(join(ws.projectDir, "api.txt"), spec.beforeCheck);
		await writeFile(join(ws.projectDir, "consumer.txt"), spec.artifact);
		const cp = checkpointSchema.parse({
			id: "cp",
			goal: ws.goalId,
			workspot: "ws",
			timestamp: new Date().toISOString(),
			lifecycle: "draft",
			assertion: "late origin",
			writerId: "writer",
			artifact: {
				path: "consumer.txt",
				inputs: ["api.txt"],
				inputRecords: [
					{ path: "api.txt", writerId: "writer", footprintSeq: first.seq },
				],
				targetRef: "main",
			},
		});
		cp.artifactOrigin = await captureArtifactSnapshot(ws.bb, cp);
		cp.artifactInputOrigin = await selectArtifactInputs(ws.bb, cp);
		await ws.bb.checkpoints.save(cp, "staging");
		expect(cp.artifactOrigin?.files["api.txt"]).toBe(
			hashText(spec.beforeCheck),
		);
		expect(cp.artifactInputOrigin).toMatchObject({
			status: "selected",
			workspot: "ws",
			cwd: ws.projectDir,
			reads: [
				{
					path: "api.txt",
					writerId: "writer",
					actingAgent: "subagent",
					footprintSeq: first.seq,
					eventId: first.eventId,
					contentHash: hashText(spec.input),
					strength: "tool-observed",
					binding: "matched",
				},
			],
		});
		await ws.bb.sessions.recordActivity("writer", {
			activity: "read-v2",
			agent: "writer",
			used: [await hashPathClaim(ws.projectDir, "api.txt")],
			generated: [],
		});
		expect((await selectArtifactInputs(ws.bb, cp))?.reads).toEqual(
			cp.artifactInputOrigin!.reads,
		);
		expect((await listArtifactReviews(ws.bb))[0]?.inputOrigin).toEqual(
			cp.artifactInputOrigin,
		);
		expect(
			(await ws.bb.checkpoints.scanZone("staging"))[0]?.artifactInputOrigin,
		).toEqual(cp.artifactInputOrigin);
		const cli = spawnSync(
			process.execPath,
			[resolve(import.meta.dir, "../index.ts"), "checkpoint", "list", "--json"],
			{ cwd: ws.projectDir, encoding: "utf8" },
		);
		expect(cli.status).toBe(0);
		expect(
			JSON.parse(cli.stdout).staging[0].currentArtifact.inputOrigin,
		).toEqual(cp.artifactInputOrigin);
	} finally {
		await ws.cleanup();
	}
});

test("same-path ranges require an unambiguous selector; absent or foreign records stay unknown", async () => {
	const ws = await setup();
	try {
		await writeFile(join(ws.projectDir, "api.txt"), "one\ntwo\nthree\nfour");
		await ws.bb.sessions.recordActivity("writer", {
			activity: "ranges",
			agent: "writer",
			used: [
				await captureReturnedInput(ws.projectDir, "api.txt", {
					returned: "one\ntwo",
					content: "one\ntwo",
					selector: { kind: "lines", start: 1, end: 2 },
				}),
				await captureReturnedInput(ws.projectDir, "api.txt", {
					returned: "three\nfour",
					content: "three\nfour",
					selector: { kind: "lines", start: 3, end: 4 },
				}),
			],
			generated: [],
		});
		const make = (records: unknown[]) =>
			checkpointSchema.parse({
				id: "cp",
				goal: ws.goalId,
				workspot: "ws",
				timestamp: new Date().toISOString(),
				lifecycle: "draft",
				assertion: "ranges",
				artifact: {
					path: "consumer.txt",
					inputs: ["api.txt"],
					inputRecords: records,
				},
			});
		const record = { path: "api.txt", writerId: "writer", footprintSeq: 1 };
		expect((await selectArtifactInputs(ws.bb, make([record])))?.status).toBe(
			"unknown",
		);
		const selected = await selectArtifactInputs(
			ws.bb,
			make([
				{ ...record, selector: { kind: "lines", start: 1, end: 2 } },
				{ ...record, selector: { kind: "lines", start: 3, end: 4 } },
			]),
		);
		expect(selected?.status).toBe("selected");
		expect(selected?.reads).toHaveLength(2);
		expect(selected?.reads.map((read) => read.selector)).toEqual([
			{ kind: "lines", start: 1, end: 2 },
			{ kind: "lines", start: 3, end: 4 },
		]);
		for (const bad of [
			{ ...record, writerId: "absent" },
			{ ...record, footprintSeq: 99 },
			{ ...record, path: "undeclared.txt" },
			{ ...record, selector: { kind: "file" } },
		])
			expect((await selectArtifactInputs(ws.bb, make([bad])))?.status).toBe(
				"unknown",
			);
		const duplicate = {
			...record,
			selector: { kind: "lines", start: 1, end: 2 },
		};
		expect(
			(await selectArtifactInputs(ws.bb, make([duplicate, duplicate])))?.status,
		).toBe("unknown");
	} finally {
		await ws.cleanup();
	}
});

test("real checkpoint create accepts explicit records and labels legacy file sampling separately", async () => {
	const ws = await setup();
	try {
		await writeFile(join(ws.projectDir, "api.txt"), "v1");
		await writeFile(join(ws.projectDir, "consumer.txt"), "*");
		await ws.bb.sessions.recordActivity("writer", {
			activity: "legacy-read",
			agent: "writer",
			used: [{ path: "api.txt", version: hashText("v1") }],
			generated: [],
		});
		await writeFile(join(ws.projectDir, "api.txt"), "v2");
		await writeFile(
			join(ws.projectDir, "check.cjs"),
			`require("node:fs").writeFileSync("report.json",JSON.stringify({numTotalTests:1,numPassedTests:1,numFailedTests:0,numPendingTests:0,success:true,testResults:[{assertionResults:[{fullName:"contract",status:"passed"}]}]}));`,
		);
		await writeFile(
			join(ws.projectDir, "records.json"),
			JSON.stringify([
				{ path: "api.txt", writerId: "writer", footprintSeq: 1 },
			]),
		);
		await writeFile(
			join(ws.projectDir, "evidence.json"),
			JSON.stringify({
				report: {
					format: "vitest-json",
					path: "report.json",
					expectedTests: ["contract"],
				},
				inputs: [],
			}),
		);
		const args = [
			resolve(import.meta.dir, "../index.ts"),
			"checkpoint",
			"create",
			"--goal",
			ws.goalId,
			"--workspot",
			"ws",
			"--assertion",
			"origin",
			"--strategy",
			"test",
			"--command",
			`"${process.execPath}" check.cjs`,
			"--evidence",
			"evidence.json",
			"--artifact",
			"consumer.txt",
			"--input",
			"api.txt",
			"--input-records",
			"records.json",
			"--json",
		];
		const cli = spawnSync(process.execPath, args, {
			cwd: ws.projectDir,
			encoding: "utf8",
		});
		expect(cli.status).toBe(0);
		const cp = JSON.parse(cli.stdout);
		expect(cp.artifactInputOrigin.reads[0]).toMatchObject({
			version: hashText("v1"),
			strength: "unknown",
			binding: "unknown",
		});
		expect(cp.artifactOrigin.files["api.txt"]).toBe(hashText("v2"));
		expect(cp.artifactOrigin.sampling).toBe("checkpoint-file-sample");
		await writeFile(join(ws.projectDir, "api.txt"), "v3");
		const rechecked = await revalidateArtifact(ws.bb, cp.id);
		expect(rechecked.verificationResult?.status).toBe("passed");
		expect(rechecked.artifactInputOrigin).toEqual(cp.artifactInputOrigin);
		expect(rechecked.artifactOrigin).toEqual(cp.artifactOrigin);
		const legacy = checkpointSchema.parse({
			...cp,
			artifact: { path: "consumer.txt", inputs: ["api.txt"] },
			artifactInputOrigin: undefined,
		});
		expect(await selectArtifactInputs(ws.bb, legacy)).toBeUndefined();
	} finally {
		await ws.cleanup();
	}
});
