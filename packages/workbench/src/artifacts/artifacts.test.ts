import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { ChatThreads } from "../chat/threads";
import { findMcpTool } from "../mcp/tools";
import { runOnce } from "../runtime";
import { initGitFixture, makeTempWorkbench } from "../test/fixtures";
import { checkpointSchema } from "../types/checkpoint";
import { workspotSchema } from "../types/workspot";
import { revalidateArtifact } from "./revalidate";
import { listArtifactReviews, reconcileArtifacts } from "./status";

function git(cwd: string, ...args: string[]) {
	return execFileSync(
		"git",
		[
			"-c",
			"core.hooksPath=",
			"-c",
			"user.name=test",
			"-c",
			"user.email=test@example.invalid",
			...args,
		],
		{ cwd, encoding: "utf8", stdio: "pipe" },
	).trim();
}

async function seed(targetRef?: string) {
	const ws = await makeTempWorkbench();
	initGitFixture(ws.projectDir);
	await writeFile(
		join(ws.projectDir, ".gitignore"),
		".workbench/\nreport.json\n",
	);
	await writeFile(join(ws.projectDir, "api.txt"), "v1");
	await writeFile(join(ws.projectDir, "consumer.txt"), "v1");
	await writeFile(
		join(ws.projectDir, "check.cjs"),
		`const fs = require('node:fs');
const api = fs.readFileSync('api.txt', 'utf8');
const consumer = fs.readFileSync('consumer.txt', 'utf8');
const ok = consumer === '*' || consumer === api;
fs.writeFileSync('report.json', JSON.stringify({ numTotalTests: 1, numPassedTests: +ok, numFailedTests: +!ok, numPendingTests: 0, success: ok, testResults: [{ assertionResults: [{fullName: 'consumer matches API', status: ok ? 'passed' : 'failed'}] }] }));
process.exitCode = ok ? 0 : 1;`,
	);
	git(
		ws.projectDir,
		"add",
		".gitignore",
		"api.txt",
		"consumer.txt",
		"check.cjs",
	);
	git(ws.projectDir, "commit", "-qm", "artifact baseline");
	const goal = await ws.bb.goals.add({ title: "consumer" }, "in_progress");
	const thread = await new ChatThreads(ws.bb).create("artifact handoff");
	await ws.bb.state.workspots.save(
		workspotSchema.parse({
			id: "ws",
			branch: "main",
			worktreePath: ws.projectDir,
			status: "active",
			primaryTask: goal.id,
		}),
	);
	await ws.bb.checkpoints.save(
		checkpointSchema.parse({
			id: "cp",
			goal: goal.id,
			workspot: "ws",
			writerId: "w",
			threadId: thread.id,
			timestamp: new Date().toISOString(),
			lifecycle: "draft",
			assertion: "consumer contract",
			artifact: { path: "consumer.txt", inputs: ["api.txt"], targetRef },
			verification: {
				strategy: "test",
				command: `"${process.execPath}" check.cjs`,
				evidence: {
					report: {
						format: "vitest-json",
						path: "report.json",
						expectedTests: ["consumer matches API"],
					},
					inputs: ["check.cjs"],
				},
			},
		}),
		"staging",
	);
	await ws.bb.goals.update(goal.id, { checkpoints: ["cp"] });
	await runOnce(ws.bb);
	await runOnce(ws.bb);
	await runOnce(ws.bb);
	return { ...ws, goalId: goal.id, threadId: thread.id };
}

test("applied artifact becomes stale across files; reread cannot repair it; revalidation preserves history and effects", async () => {
	const ws = await seed();
	try {
		const original = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		expect(original.lifecycle).toBe("applied");
		expect((await ws.bb.goals.get(ws.goalId))?.status).toBe("done");
		expect((await listArtifactReviews(ws.bb))[0]?.status).toBe("current");
		const effects = await ws.bb.interfaces.list();
		const applications = await ws.bb.events.query({
			type: "checkpoint_applied",
		});
		await writeFile(join(ws.projectDir, "unrelated.txt"), "unrelated");
		expect((await listArtifactReviews(ws.bb))[0]?.status).toBe("current");
		await writeFile(join(ws.projectDir, "api.txt"), "v2");
		await ws.bb.sessions.register("w", "agent");
		await ws.bb.sessions.recordActivity("w", {
			activity: "reread",
			agent: "w",
			used: [await hashPathClaim(ws.projectDir, "api.txt")],
			generated: [],
		});
		expect((await listArtifactReviews(ws.bb))[0]?.status).toBe("stale");
		await reconcileArtifacts(ws.bb);
		const eventCount = (await ws.bb.events.query({ type: "artifact_validity" }))
			.length;
		await reconcileArtifacts(ws.bb);
		expect(
			await ws.bb.events.query({ type: "artifact_validity" }),
		).toHaveLength(eventCount);
		const fail = await revalidateArtifact(ws.bb, "cp");
		expect(fail.verificationResult?.status).toBe("failed");
		expect((await listArtifactReviews(ws.bb))[0]?.status).toBe("failed");
		await writeFile(join(ws.projectDir, "consumer.txt"), "*");
		const pass = await revalidateArtifact(ws.bb, fail.id);
		expect(pass.verificationResult?.evidence?.status).toBe("satisfied");
		expect(pass.artifactOrigin).toEqual(original.artifactOrigin);
		expect(pass.blackboardEffects?.publish).toHaveLength(0);
		await runOnce(ws.bb);
		expect(
			(await ws.bb.checkpoints.scanZone("verified")).find(
				(cp) => cp.id === "cp",
			),
		).toEqual(original);
		expect(await ws.bb.interfaces.list()).toEqual(effects);
		expect(await ws.bb.events.query({ type: "checkpoint_applied" })).toEqual(
			applications,
		);
		await writeFile(join(ws.projectDir, "api.txt"), "v3");
		const before = await readFile(join(ws.projectDir, "consumer.txt"), "utf8");
		const noEdit = await revalidateArtifact(ws.bb, pass.id);
		expect(noEdit.verificationResult?.status).toBe("passed");
		expect(await readFile(join(ws.projectDir, "consumer.txt"), "utf8")).toBe(
			before,
		);
		expect((await listArtifactReviews(ws.bb))[0]?.status).toBe("current");
		expect(
			await findMcpTool("resume_cards")!.run({ threadId: ws.threadId }, ws.bb),
		).toContain("consumer.txt");
		const cli = spawnSync(
			process.execPath,
			[resolve(import.meta.dir, "../index.ts"), "checkpoint", "list", "--json"],
			{ cwd: ws.projectDir, encoding: "utf8" },
		);
		expect(cli.status).toBe(0);
		expect(
			JSON.parse(cli.stdout).verified.find(
				(cp: { id: string }) => cp.id === "cp",
			).currentArtifact.checkpointId,
		).toBe(noEdit.id);
	} finally {
		await ws.cleanup();
	}
}, 60_000);

test("worktree and target identity remain separate; rerunning old worktree cannot endorse advanced main", async () => {
	const ws = await seed("main");
	try {
		const side = join(ws.projectDir, "worktree");
		git(ws.projectDir, "worktree", "add", "-q", "-b", "side", side);
		await ws.bb.state.workspots.save(
			workspotSchema.parse({
				id: "side",
				branch: "side",
				worktreePath: side,
				status: "active",
				primaryTask: ws.goalId,
			}),
		);
		const moved = await revalidateArtifact(ws.bb, "cp", { workspot: "side" });
		expect(moved.artifactBinding?.cwd).not.toBe(moved.artifactOrigin?.cwd);
		expect((await listArtifactReviews(ws.bb))[0]?.targetStatus).toBe(
			"inputs-match",
		);
		await writeFile(join(ws.projectDir, "api.txt"), "v2");
		git(ws.projectDir, "add", "api.txt");
		git(ws.projectDir, "commit", "-qm", "main advances");
		expect((await listArtifactReviews(ws.bb))[0]?.status).toBe("stale");
		expect(await readFile(join(side, "api.txt"), "utf8")).toBe("v1");
		const oldWorktree = await revalidateArtifact(ws.bb, moved.id);
		expect(oldWorktree.verificationResult?.status).toBe("passed");
		expect((await listArtifactReviews(ws.bb))[0]?.targetStatus).toBe(
			"inputs-differ",
		);
		expect((await listArtifactReviews(ws.bb))[0]?.reason).toContain(
			"目标适用性未验证",
		);
		const missing = await revalidateArtifact(ws.bb, oldWorktree.id, {
			targetRef: "absent",
		});
		expect(missing.verificationBinding).toBeUndefined();
		expect((await listArtifactReviews(ws.bb))[0]?.status).toBe("unknown");
	} finally {
		await ws.cleanup();
	}
}, 60_000);

test("staging/committing identical declared contents preserves local artifact evidence; check program drift does not", async () => {
	const ws = await seed();
	try {
		await writeFile(join(ws.projectDir, "consumer.txt"), "*");
		await revalidateArtifact(ws.bb, "cp");
		git(ws.projectDir, "add", "consumer.txt");
		git(ws.projectDir, "commit", "-qm", "same tested content");
		expect((await listArtifactReviews(ws.bb))[0]?.status).toBe("current");
		await writeFile(join(ws.projectDir, "check.cjs"), "process.exit(0)");
		expect((await listArtifactReviews(ws.bb))[0]?.status).toBe("stale");
	} finally {
		await ws.cleanup();
	}
}, 60_000);
