import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { buildBranchL1Summary } from "../chat/resume-card/l1-summary";
import { initGitFixture, makeTempWorkbench } from "../test/fixtures";
import { checkpointSchema } from "../types/checkpoint";
import { workspotSchema } from "../types/workspot";
import { runOnce } from "./index";
import { reconcilePremises } from "./premises";
import { reviewCheckpoint } from "./review";
import { checkpointVerificationStatus } from "./verification-status";

async function seed() {
	const ws = await makeTempWorkbench();
	initGitFixture(ws.projectDir);
	await writeFile(join(ws.projectDir, "check.cjs"), "process.exit(0);");
	const goal = await ws.bb.goals.add({ title: "verified work" }, "in_progress");
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
			threadId: "thread",
			timestamp: new Date().toISOString(),
			lifecycle: "draft",
			assertion: "check passes",
			verification: {
				strategy: "test",
				command: `"${process.execPath}" check.cjs`,
			},
		}),
		"staging",
	);
	await runOnce(ws.bb);
	expect(
		(await ws.bb.checkpoints.scanZone("verified"))[0]?.verificationResult
			?.status,
	).toBe("passed");
	return ws;
}

test.each([
	"command",
	"expectedExitCode",
	"timeout",
] as const)("changing verification %s after success requires revalidation", async (field) => {
	const ws = await seed();
	try {
		const cp = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		const verification = {
			...cp.verification!,
			[field]:
				field === "command"
					? `"${process.execPath}" -e "process.exit(1)"`
					: field === "timeout"
						? 2
						: 1,
		};
		await ws.bb.checkpoints.save({ ...cp, verification }, "verified");
		await runOnce(ws.bb);
		expect((await ws.bb.checkpoints.scanZone("staging"))[0]?.lifecycle).toBe(
			"draft",
		);
		expect((await ws.bb.goals.get(cp.goal))?.status).toBe("in_progress");
	} finally {
		await ws.cleanup();
	}
});

test("moving to another worktree with identical HEAD and contents invalidates execution context", async () => {
	const ws = await seed();
	try {
		const other = join(ws.projectDir, "other-worktree");
		execFileSync("git", ["worktree", "add", "--detach", other, "HEAD"], {
			cwd: ws.projectDir,
			stdio: "pipe",
		});
		await copyFile(join(ws.projectDir, "check.cjs"), join(other, "check.cjs"));
		const spot = (await ws.bb.state.workspots.get("ws"))!;
		await ws.bb.state.workspots.save({ ...spot, worktreePath: other });
		await runOnce(ws.bb);
		expect((await ws.bb.checkpoints.scanZone("staging"))[0]?.lifecycle).toBe(
			"draft",
		);
	} finally {
		await ws.cleanup();
	}
});

test("CLI and restore projection show expired evidence before sync without rewriting history", async () => {
	const ws = await seed();
	try {
		const cp = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		expect((await checkpointVerificationStatus(ws.bb, cp)).status).toBe(
			"passed",
		);
		await writeFile(join(ws.projectDir, "check.cjs"), "process.exit(1);");
		const eventCount = (await ws.bb.events.all()).length;
		expect((await checkpointVerificationStatus(ws.bb, cp)).status).toBe(
			"stale",
		);
		const summary = await buildBranchL1Summary({
			bb: ws.bb,
			branch: { id: "thread", title: "work" },
			events: [],
			isAfterLeave: () => true,
			counterpartyWrites: new Set(),
		});
		expect(
			summary.lines.find((line) => line.kind === "verifier")?.text,
		).toContain("验证已过期");
		const cli = spawnSync(
			process.execPath,
			[resolve(import.meta.dir, "../index.ts"), "checkpoint", "list", "--json"],
			{ cwd: ws.projectDir, encoding: "utf8" },
		);
		expect(cli.status).toBe(0);
		expect(JSON.parse(cli.stdout).verified[0].currentVerification.status).toBe(
			"stale",
		);
		expect((await ws.bb.events.all()).length).toBe(eventCount);
		expect(
			(await ws.bb.checkpoints.scanZone("verified"))[0]?.verificationResult
				?.status,
		).toBe("passed");
	} finally {
		await ws.cleanup();
	}
});

test("human approval has its own authority and does not claim a repeated automatic check", async () => {
	const ws = await seed();
	try {
		const cp = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		await ws.bb.checkpoints.save(
			{ ...cp, lifecycle: "awaiting_review" },
			"verified",
		);
		await ws.bb.checkpoints.move(cp.id, "verified", "staging");
		expect((await reviewCheckpoint(ws.bb, cp.id, true)).ok).toBe(true);
		const approved = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		expect((await checkpointVerificationStatus(ws.bb, approved)).status).toBe(
			"approved",
		);
		expect(approved.verificationBinding?.context?.authority).toBe("human");
		expect(
			await ws.bb.events.query({ type: "request_verification" }),
		).toHaveLength(1);
	} finally {
		await ws.cleanup();
	}
});

test("restore counts current stale files, not historical detection events", async () => {
	const ws = await seed();
	try {
		await ws.bb.sessions.register("thread", "agent");
		const read = async () =>
			ws.bb.sessions.recordActivity("thread", {
				activity: "read",
				agent: "thread",
				used: [await hashPathClaim(ws.projectDir, "check.cjs")],
				generated: [],
				facets: { tool: "Read" },
			});
		await read();
		await writeFile(join(ws.projectDir, "check.cjs"), "process.exit(1);");
		await reconcilePremises(ws.bb);
		const snapshot = async () =>
			buildBranchL1Summary({
				bb: ws.bb,
				branch: { id: "thread", title: "work" },
				events: await ws.bb.events.all(),
				isAfterLeave: () => true,
				counterpartyWrites: new Set(),
			});
		expect(
			(await snapshot()).lines.find((line) => line.kind === "verifier")?.text,
		).toContain("当前观测到 1 个失效文件");
		await read();
		const refreshed = (await snapshot()).lines.find(
			(line) => line.kind === "verifier",
		)!;
		expect(refreshed.text).toContain("当前观测到 0 个失效文件");
		expect(refreshed.text).toContain("历史检测记录 1 条");
		expect(refreshed.text).toContain("验证已过期");
	} finally {
		await ws.cleanup();
	}
});

test.each([
	"failed",
	"timeout",
	"skipped",
	"needs_human",
])("resume summary never presents %s as verified", async (status) => {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.checkpoints.save(
			checkpointSchema.parse({
				id: "cp",
				goal: "g",
				workspot: "ws",
				threadId: "thread",
				timestamp: new Date().toISOString(),
				lifecycle: "failed",
				assertion: "check",
				verificationResult: { status, at: new Date().toISOString() },
			}),
			"failed",
		);
		const summary = await buildBranchL1Summary({
			bb: ws.bb,
			branch: { id: "thread", title: "work" },
			events: [],
			isAfterLeave: () => true,
			counterpartyWrites: new Set(),
		});
		expect(
			summary.lines.find((line) => line.kind === "verifier")?.text,
		).not.toContain("已验证");
	} finally {
		await ws.cleanup();
	}
});
