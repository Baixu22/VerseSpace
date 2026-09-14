import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { type Blackboard, openBlackboard } from "../blackboard";
import { checkpointCreate } from "../commands/checkpoint";
import { initWorkbench } from "../commands/init";
import { runDoctor } from "../doctor";
import { runOnce } from "../runtime";
import type { Checkpoint } from "../types/checkpoint";
import type { Workspot } from "../types/workspot";

/**
 * MVP end-to-end: a REAL git repository drives the full loop —
 * init → dependent goals → worktree verification (pass and fail branches) →
 * interface drift propagating staleness → settled world is a no-op.
 *
 * Transitions always derive from the ENTRY snapshot, so the world advances one
 * stage per sync (single-round, no recursion) — the sequence below asserts
 * exactly that rhythm.
 */

async function makeGitProject(): Promise<{
	projectDir: string;
	bb: Blackboard;
	cleanup(): Promise<void>;
}> {
	const projectDir = join(
		tmpdir(),
		`workbench-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(projectDir, { recursive: true });
	const git = spawnSync("git", ["init", "-q"], { cwd: projectDir });
	if (git.status !== 0) {
		throw new Error(`git init failed: ${git.stderr?.toString()}`);
	}
	await initWorkbench(projectDir);
	const bb = openBlackboard(join(projectDir, ".workbench"));
	return {
		projectDir,
		bb,
		cleanup: () => rm(projectDir, { recursive: true, force: true }),
	};
}

async function dropCheckpoint(
	bb: Blackboard,
	projectDir: string,
	goalId: string,
	scriptExitCode: number,
): Promise<string> {
	const worktree = join(projectDir, "worktrees", "ws-a");
	await mkdir(worktree, { recursive: true });
	await writeFile(
		join(worktree, "script.js"),
		`if (${scriptExitCode} !== 0) console.error("verification blew up");\nprocess.exit(${scriptExitCode});\n`,
		"utf8",
	);
	const id = `cp-${goalId}-${scriptExitCode}`;
	const checkpoint: Checkpoint = {
		id,
		goal: goalId,
		workspot: "ws-a",
		timestamp: new Date().toISOString(),
		lifecycle: "draft",
		assertion: "worktree script passes",
		verification: { strategy: "test", command: "bun script.js" },
		artifacts: [],
		unblocks: [],
	};
	await bb.checkpoints.save(checkpoint, "staging");
	return id;
}

function workspotOn(goalId: string): Workspot {
	return {
		id: "ws-a",
		branch: "ws/ws-a",
		worktreePath: join("worktrees", "ws-a"),
		primaryTask: goalId,
		binding: "primary",
		status: "active",
		contextNeeds: { decisions: [], interfaces: [] },
	};
}

describe("MVP end-to-end flow (real git repo)", () => {
	test("init → dependent goals → worktree verification → done → drift → stale", async () => {
		const { projectDir, bb, cleanup } = await makeGitProject();
		try {
			// contract file + registry entry; first sync anchors it to real content
			await mkdir(join(projectDir, "contracts"), { recursive: true });
			await writeFile(
				join(projectDir, "contracts", "api.md"),
				"# api v1\n",
				"utf8",
			);
			await bb.interfaces.register({
				key: "core/api",
				canonicalPath: "contracts/api.md",
				version: 1,
				publishedBy: "human",
				lastModified: new Date().toISOString(),
				contentHash: "seed",
				subscribers: [],
			});
			expect((await runOnce(bb)).reanchored).toEqual(["core/api"]);

			const goalA = await bb.goals.add({ title: "先做的事" });
			const goalB = await bb.goals.add({
				title: "依赖 A 的后续事",
				dependsOn: [goalA.id],
			});
			await bb.state.workspots.save(workspotOn(goalA.id));

			// sync 1: A planned → ready (entry snapshot saw A as planned, so no
			// enqueue yet — single-round semantics)
			const run1 = await runOnce(bb);
			expect(run1.transitions.map((t) => t.type)).toEqual(["goal_status"]);
			expect((await bb.goals.get(goalA.id))?.status).toBe("ready");

			// sync 2: already active work is in_progress and never waits in the queue.
			const run2 = await runOnce(bb);
			expect(run2.transitions.map((t) => t.type)).toEqual(["goal_status"]);
			expect((await bb.goals.get(goalA.id))?.status).toBe("in_progress");
			expect(await bb.state.queue.get()).toEqual([]);
			expect(
				(await runDoctor(bb)).issues.some(
					(issue) => issue.check === "stale_queue_entry",
				),
			).toBe(false);

			// sync 3: drop a passing checkpoint; verification executes this round
			const cpA = await dropCheckpoint(bb, projectDir, goalA.id, 0);
			const run3 = await runOnce(bb);
			expect(run3.verifications.map((v) => v.result.status)).toEqual([
				"passed",
			]);
			expect(
				(await bb.checkpoints.scanZone("verified")).map((cp) => cp.id),
			).toContain(cpA);

			// sync 4: verified → applied
			await runOnce(bb);
			const appliedCp = (await bb.checkpoints.scanZone("verified")).find(
				(cp) => cp.id === cpA,
			);
			expect(appliedCp?.lifecycle).toBe("applied");

			// sync 5: A completes; the workspot is released with fresh context
			await runOnce(bb);
			expect((await bb.goals.get(goalA.id))?.status).toBe("done");
			expect((await bb.state.workspots.get("ws-a"))?.status).toBe("idle");
			const refreshed = await readFile(
				join(projectDir, "worktrees", "ws-a", ".agent-context.md"),
				"utf8",
			);
			expect(refreshed).toContain("自动生成");

			// sync 6: B's dependency is done → ready
			await runOnce(bb);
			expect((await bb.goals.get(goalB.id))?.status).toBe("ready");

			// failed branch: work on B, verification blows up
			await bb.state.workspots.save(workspotOn(goalB.id));
			const cpB = await dropCheckpoint(bb, projectDir, goalB.id, 1);
			const failRun = await runOnce(bb);
			expect(failRun.verifications.map((v) => v.result.status)).toEqual([
				"failed",
			]);
			const failedCp = (await bb.checkpoints.scanZone("failed")).find(
				(cp) => cp.id === cpB,
			);
			expect(failedCp?.lifecycle).toBe("failed");
			expect(failedCp?.verificationResult?.status).toBe("failed");
			expect(failedCp?.verificationResult?.output).toContain(
				"verification blew up",
			);
			await expect(
				bb.events.query({ type: "verification_failed" }),
			).resolves.toHaveLength(1);

			// human gives up on B; the workspot gets blocked by the machine
			await bb.goals.update(goalB.id, { status: "cancelled" });
			const blockedRun = await runOnce(bb);
			expect(
				blockedRun.transitions.some(
					(t) => t.type === "workspot_status" && t.to === "blocked",
				),
			).toBe(true);

			// drift: contract content changes; sync re-anchors the registry
			await appendFile(
				join(projectDir, "contracts", "api.md"),
				"\n# breaking\n",
				"utf8",
			);
			expect((await runOnce(bb)).reanchored).toEqual(["core/api"]);

			// next sync: A (anchored at v1) goes stale
			await runOnce(bb);
			const staleA = await bb.goals.get(goalA.id);
			expect(staleA?.status).toBe("stale_done");
			expect(staleA?.staleReason).toContain("core/api");

			// settled world: sync is a no-op
			const quiet = await runOnce(bb);
			expect(quiet.applied).toBe(0);
			expect(quiet.reanchored).toEqual([]);
		} finally {
			await cleanup();
		}
	}, 60_000);

	test("ws create 后（未 dispatch）直接 checkpoint create 应成功且 rollback 缺失（issue #1）", async () => {
		const { projectDir, bb, cleanup } = await makeGitProject();
		const prevCwd = process.cwd();
		process.chdir(projectDir);
		try {
			// 验收原文顺序：init → goal add → ws create → 落 checkpoint。
			// ws create 只登记 workspot，不建 worktree（dispatch 才建）——
			// 曾经这个顺序被 checkpoint schema 以裸 zod JSON 拒绝。
			const goalA = await bb.goals.add({ title: "先落检查点" });
			await bb.state.workspots.save(workspotOn(goalA.id));
			expect(
				(await bb.state.workspots.get("ws-a"))?.worktreePath,
			).toBeDefined();

			const command = {
				optsWithGlobals: () => ({ json: false, quiet: true }),
			} as unknown as Command;
			await expect(
				checkpointCreate(
					{
						goal: goalA.id,
						assertion: "无 worktree 也能落 checkpoint",
						workspot: "ws-a",
					},
					command,
				),
			).resolves.toBeUndefined();

			const saved = (await bb.checkpoints.scanZone("staging")).at(-1);
			expect(saved).toBeDefined();
			expect(saved?.goal).toBe(goalA.id);
			expect(saved?.rollback).toBeUndefined();

			// goal 的 checkpoints 列表同步登记（否则 doctor 会报 dangling 引用）
			const updatedGoal = await bb.goals.get(goalA.id);
			expect(updatedGoal?.checkpoints).toContain(saved?.id);
		} finally {
			process.chdir(prevCwd);
			await cleanup();
		}
	}, 60_000);
});
