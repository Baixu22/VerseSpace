import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runOnce } from "../runtime";
import { makeCommittedRepo } from "../test/git-project";
import { dispatchGoal } from "./dispatch";

describe("dispatchGoal (real git worktree)", () => {
	test("creates the worktree, activates the workspot, dequeues, refreshes context", async () => {
		const { projectDir, bb, cleanup } = await makeCommittedRepo();
		try {
			const goal = await bb.goals.add({ title: "被派发的目标" });
			await bb.goals.update(goal.id, { status: "ready" });
			await bb.state.workspots.save({
				id: "ws-a",
				branch: "ws/ws-a",
				worktreePath: join("worktrees", "ws-a"),
				primaryTask: "g-0",
				binding: "primary",
				status: "idle",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			await bb.state.queue.enqueue(goal.id);

			const result = await dispatchGoal(bb, goal.id);
			expect(result.ok).toBe(true);

			// worktree exists and is a real git worktree (a .git file, not dir)
			const worktreePath = join(projectDir, "worktrees", "ws-a");
			const gitMarker = await readFile(join(worktreePath, ".git"), "utf8");
			expect(gitMarker).toContain("gitdir:");

			const ws = await bb.state.workspots.get("ws-a");
			expect(ws?.status).toBe("active");
			expect(ws?.primaryTask).toBe(goal.id);
			expect(await bb.state.queue.get()).toEqual([]);

			const context = await readFile(
				join(worktreePath, ".agent-context.md"),
				"utf8",
			);
			expect(context).toContain("被派发的目标");

			const events = await bb.events.query({ type: "goal_dispatched" });
			expect(events).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	test("refuses goals that are not ready", async () => {
		const { bb, cleanup } = await makeCommittedRepo();
		try {
			const goal = await bb.goals.add({ title: "还在计划中" });
			const result = await dispatchGoal(bb, goal.id);
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("planned");
		} finally {
			await cleanup();
		}
	});

	test("refuses when there is no idle workspot", async () => {
		const { bb, cleanup } = await makeCommittedRepo();
		try {
			const goal = await bb.goals.add({ title: "A" });
			await bb.goals.update(goal.id, { status: "ready" });
			const result = await dispatchGoal(bb, goal.id);
			expect(result.ok).toBe(false);
			expect(result.reason).toContain("没有空闲工位");
		} finally {
			await cleanup();
		}
	});

	test("checks out an existing branch instead of creating it", async () => {
		const { projectDir, bb, cleanup } = await makeCommittedRepo();
		try {
			const goal = await bb.goals.add({ title: "A" });
			await bb.goals.update(goal.id, { status: "ready" });
			await bb.state.workspots.save({
				id: "ws-a",
				branch: "ws/ws-a",
				worktreePath: join("worktrees", "ws-a"),
				primaryTask: "g-0",
				binding: "primary",
				status: "idle",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			// the branch already exists — createWorktree must fall back to a
			// plain checkout of it
			const branch = spawnSync("git", ["branch", "ws/ws-a"], {
				cwd: projectDir,
			});
			expect(branch.status).toBe(0);

			const result = await dispatchGoal(bb, goal.id);
			expect(result.ok).toBe(true);
			const marker = await readFile(
				join(projectDir, "worktrees", "ws-a", ".git"),
				"utf8",
			);
			expect(marker).toContain("gitdir:");
		} finally {
			await cleanup();
		}
	});

	test("runOnce with auto policy dispatches through the scheduler", async () => {
		const { bb, cleanup } = await makeCommittedRepo();
		try {
			const goal = await bb.goals.add({ title: "自动派发" });
			await bb.goals.update(goal.id, { status: "ready" });
			await bb.state.workspots.save({
				id: "ws-a",
				branch: "ws/ws-a",
				worktreePath: join("worktrees", "ws-a"),
				primaryTask: "g-0",
				binding: "primary",
				status: "idle",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			const config = await bb.config.load();
			config.scheduler.policy = "auto";
			await bb.config.save(config);

			// the scheduler stage reads post-transition state, so the dispatch
			// happens this round even though the goal only enters the queue now
			const run = await runOnce(bb);
			expect(run.dispatches).toHaveLength(1);
			expect(run.dispatches[0]?.ok).toBe(true);
			expect((await bb.state.workspots.get("ws-a"))?.status).toBe("active");
			// activation happened after the snapshot → in_progress lands next sync
			expect((await bb.goals.get(goal.id))?.status).toBe("ready");

			// next sync: ready + active workspot → in_progress
			const run2 = await runOnce(bb);
			expect(run2.dispatches).toEqual([]);
			expect((await bb.goals.get(goal.id))?.status).toBe("in_progress");
		} finally {
			await cleanup();
		}
	});
});
