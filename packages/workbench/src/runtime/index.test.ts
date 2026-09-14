import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBlackboard } from "../blackboard";
import { registryContextStore } from "../blackboard/context-store";
import { initWorkbench } from "../commands/init";
import { acquirePidLock } from "../fs/lockfile";
import type { Checkpoint } from "../types/checkpoint";
import { runOnce } from "./index";
import { applyRollback, planRollback } from "./rollback";

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

			// round 2: start (workspot active) + verified → applied
			//
			// 这里刻意**不**期望 enqueue：工位 ws-a 已经在施工该目标，队列是
			// 「等派发」的名单，正在施工的目标不属于它（issue #6 item 10，见
			// goal-machine.ts 的 workedOn 分支）。此前无条件入队，导致派发/
			// 同步之间队列抖动，doctor 会看到假 stale_queue_entry。
			const run2 = await runOnce(bb);
			expect(run2.applied).toBe(2);
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

	test("TF-0098: checkpoint apply 在效果落地前捕获上下文快照，回退可还原", async () => {
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

			// 预置一个已存在的注册表条目 v1——它是上下文回退的「旧值」
			await bb.interfaces.register({
				key: "iface:demo",
				canonicalPath: "interfaces/demo.yaml",
				version: 1,
				publishedBy: "human",
				lastModified: new Date().toISOString(),
				contentHash: "hash-v1",
				subscribers: [],
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
				blackboardEffects: {
					publish: [],
					update: [
						{ key: "iface:demo", field: "contentHash", value: "hash-v2" },
					],
				},
			};
			await bb.checkpoints.save(checkpoint, "staging");

			// round 1: 验证通过 → verified（条目仍是 v1）
			await runOnce(bb);
			// round 2: verified → applied，apply 时刻采集上下文快照
			const run2 = await runOnce(bb);
			expect(
				run2.transitions.some(
					(t) => t.type === "checkpoint_lifecycle" && t.to === "applied",
				),
			).toBe(true);

			// 效果落地（模拟写者推进版本 v1 → v2）——发生在快照采集**之后**
			await bb.interfaces.updateVersion("iface:demo", "hash-v2");

			// applied checkpoint 携带的是采集时的旧值 v1
			const applied = (await bb.checkpoints.scanZone("verified")).find(
				(cp) => cp.id === "cp-1",
			);
			const snap = applied?.rollback?.context?.["iface:demo"] as
				| { contentHash?: string; version?: number }
				| undefined;
			expect(snap?.contentHash).toBe("hash-v1");
			expect(snap?.version).toBe(1);

			// 用快照回退上下文：v2 → v1
			const store = registryContextStore(bb);
			const plan = await planRollback(applied!, "context", { store });
			expect(plan.error).toBeUndefined();
			expect(plan.pending).toBe(1);
			const result = await applyRollback(plan, applied!, { store });
			expect(result.ok).toBe(true);
			expect(result.context).toEqual(["iface:demo"]);
			const restored = await bb.interfaces.getEntry("iface:demo");
			expect(restored?.contentHash).toBe("hash-v1");
		} finally {
			await cleanup();
		}
	});

	test("is single-writer: a held run lock makes the cycle report busy, not race", async () => {
		const { projectDir, cleanup } = await makeTempProject();
		try {
			await initWorkbench(projectDir);
			const bb = openBlackboard(join(projectDir, ".workbench"));
			await bb.goals.add({ title: "锁测试" });
			const goalBefore = (await bb.goals.list())[0];

			const holder = await acquirePidLock(join(bb.paths.root, "run.lock"));
			expect(holder.acquired).toBe(true);
			try {
				const busy = await runOnce(bb);
				expect(busy.busy).toBe(true);
				expect(busy.lockHolder).toBe(process.pid);
				expect(busy.applied).toBe(0);
				// nothing was evaluated or applied behind the caller's back
				expect((await bb.goals.get(goalBefore?.id ?? ""))?.status).toBe(
					"planned",
				);
			} finally {
				await holder.release();
			}

			// freed lock → the cycle runs normally
			const run = await runOnce(bb);
			expect(run.busy).toBeUndefined();
			expect(run.applied).toBe(1);
		} finally {
			await cleanup();
		}
	});
});
