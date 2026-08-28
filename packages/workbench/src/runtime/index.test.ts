import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBlackboard } from "../blackboard";
import { initWorkbench } from "../commands/init";
import type { Checkpoint } from "../types/checkpoint";
import { runOnce } from "./index";

async function makeTempProject(): Promise<{
	projectDir: string;
	cleanup(): Promise<void>;
}> {
	const projectDir = join(
		tmpdir(),
		`workbench-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(projectDir, { recursive: true });
	return {
		projectDir,
		cleanup: () => rm(projectDir, { recursive: true, force: true }),
	};
}

describe("runOnce", () => {
	test("applies automaton transitions through the blackboard and is idempotent", async () => {
		const { projectDir, cleanup } = await makeTempProject();
		try {
			await initWorkbench(projectDir);
			const bb = openBlackboard(join(projectDir, ".workbench"));
			await bb.goals.add({ title: "A" });

			// round 1: planned → ready (enqueue belongs to the next round — the
			// automaton judges the entry snapshot, single-round semantics)
			const first = await runOnce(bb);
			expect(first.applied).toBe(1);
			expect(first.transitions.map((t) => t.type)).toEqual(["goal_status"]);

			// round 2: now ready → enqueued
			const second = await runOnce(bb);
			expect(second.applied).toBe(1);
			expect(second.transitions.map((t) => t.type)).toEqual(["enqueue_goal"]);

			// round 3: the world is already consistent
			const third = await runOnce(bb);
			expect(third.applied).toBe(0);
			expect(third.reanchored).toEqual([]);

			const goal = (await bb.goals.list())[0];
			if (!goal) {
				throw new Error("goal missing");
			}
			expect(goal.status).toBe("ready");
			expect(await bb.state.queue.get()).toEqual([goal.id]);
		} finally {
			await cleanup();
		}
	});

	test("request_verification drives a checkpoint through the verifier", async () => {
		const { projectDir, cleanup } = await makeTempProject();
		try {
			await initWorkbench(projectDir);
			const bb = openBlackboard(join(projectDir, ".workbench"));
			const goal = await bb.goals.add({ title: "A" });
			await mkdir(join(projectDir, "worktrees", "ws-a"), { recursive: true });
			await writeFile(
				join(projectDir, "worktrees", "ws-a", "script.js"),
				"process.exit(0);\n",
				"utf8",
			);
			await bb.state.workspots.save({
				id: "ws-a",
				branch: "ws/ws-a",
				worktreePath: join("worktrees", "ws-a"),
				primaryTask: goal.id,
				binding: "primary",
				status: "active",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			const checkpoint: Checkpoint = {
				id: "cp-1",
				goal: goal.id,
				workspot: "ws-a",
				timestamp: new Date().toISOString(),
				lifecycle: "draft",
				assertion: "passes",
				verification: { strategy: "test", command: "bun script.js" },
				artifacts: [],
				unblocks: [],
			};
			await bb.checkpoints.save(checkpoint, "staging");

			// round 1: planned → ready + the draft checkpoint requests verification
			const run1 = await runOnce(bb);
			expect(run1.applied).toBe(2);
			expect(run1.verifications).toEqual([
				{ cpId: "cp-1", result: { status: "passed" } },
			]);
			expect(
				(await bb.checkpoints.scanZone("verified")).map((cp) => cp.id),
			).toEqual(["cp-1"]);
			expect((await bb.goals.get(goal.id))?.status).toBe("ready");

			// round 2: enqueue + start (workspot active) + verified → applied
			const run2 = await runOnce(bb);
			expect(run2.applied).toBe(3);
			expect(
				run2.transitions.some(
					(t) => t.type === "checkpoint_lifecycle" && t.to === "applied",
				),
			).toBe(true);
			expect((await bb.goals.get(goal.id))?.status).toBe("in_progress");

			// round 3: verified checkpoint in hand → done
			await runOnce(bb);
			expect((await bb.goals.get(goal.id))?.status).toBe("done");
		} finally {
			await cleanup();
		}
	});
});
