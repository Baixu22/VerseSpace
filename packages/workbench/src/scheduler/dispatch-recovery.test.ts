import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blackboard } from "../blackboard";
import { runDoctor } from "../doctor";
import { runOnce } from "../runtime";
import { makeCommittedRepo } from "../test/git-project";
import type { WorkspotStatus } from "../types/workspot";
import { dispatchGoal } from "./dispatch";

async function seedWorkspot(
	bb: Blackboard,
	id: string,
	status: WorkspotStatus,
	taskId: string,
): Promise<void> {
	await bb.state.workspots.save({
		id,
		branch: id,
		worktreePath: join("worktrees", id),
		primaryTask: taskId,
		binding: "primary",
		status,
		contextNeeds: { decisions: [], interfaces: [] },
	});
}

/** Record the status of every workspot write, then optionally fail one. */
function traceSaves(
	bb: Blackboard,
	failOn?: WorkspotStatus,
): { statuses: WorkspotStatus[] } {
	const statuses: WorkspotStatus[] = [];
	const original = bb.state.workspots.save.bind(bb.state.workspots);
	bb.state.workspots.save = async (workspot) => {
		statuses.push(workspot.status);
		if (failOn !== undefined && workspot.status === failOn) {
			throw new Error("模拟状态写失败");
		}
		return original(workspot);
	};
	return { statuses };
}

describe("dispatch 两阶段创建与双向回滚（TF-0203）", () => {
	test("崩溃留在 initializing 的工位：下一轮 runOnce 恢复为 idle 并留下事件", async () => {
		const { bb, cleanup } = await makeCommittedRepo();
		try {
			// 等于「phase 1 写完状态行、进程就死了」：状态行在，worktree 没建
			await seedWorkspot(bb, "ws-a", "initializing", "g-0");

			const run = await runOnce(bb);
			expect(run.recovered).toEqual(["ws-a"]);
			expect((await bb.state.workspots.get("ws-a"))?.status).toBe("idle");

			const events = await bb.events.query({ type: "dispatch_recovered" });
			expect(events).toHaveLength(1);
			expect((events[0]?.payload as { workspotId: string }).workspotId).toBe(
				"ws-a",
			);
		} finally {
			await cleanup();
		}
	});

	test("恢复是幂等的：第二轮没有可恢复的工位，也不重复写事件", async () => {
		const { bb, cleanup } = await makeCommittedRepo();
		try {
			await seedWorkspot(bb, "ws-a", "initializing", "g-0");
			await runOnce(bb);
			const second = await runOnce(bb);
			expect(second.recovered).toEqual([]);
			expect(
				await bb.events.query({ type: "dispatch_recovered" }),
			).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	test("doctor 在恢复前点名中断的 dispatch，恢复后不再报", async () => {
		const { bb, cleanup } = await makeCommittedRepo();
		try {
			await seedWorkspot(bb, "ws-a", "initializing", "g-0");
			const before = await runDoctor(bb);
			expect(
				before.issues.some((issue) => issue.check === "interrupted_dispatch"),
			).toBe(true);

			await runOnce(bb);
			const after = await runDoctor(bb);
			expect(
				after.issues.some((issue) => issue.check === "interrupted_dispatch"),
			).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("git 建 worktree 失败：状态行当场回滚为 idle，不留 initializing", async () => {
		const { projectDir, bb, cleanup } = await makeCommittedRepo();
		try {
			const goal = await bb.goals.add({ title: "派发会失败" });
			await bb.goals.update(goal.id, { status: "ready" });
			await seedWorkspot(bb, "ws-a", "idle", goal.id);
			// 让 worktree 路径被一个普通文件占住 → `git worktree add` 必然失败
			await mkdir(join(projectDir, "worktrees"), { recursive: true });
			await writeFile(join(projectDir, "worktrees", "ws-a"), "占位\n", "utf8");

			const { statuses } = traceSaves(bb);
			const result = await dispatchGoal(bb, goal.id, "ws-a");

			expect(result.ok).toBe(false);
			// 先认领（两阶段的第一阶段）再回滚，而不是压根没写状态行
			expect(statuses).toEqual(["initializing", "idle"]);
			expect((await bb.state.workspots.get("ws-a"))?.status).toBe("idle");
			// 当场回滚过，就不该再等 runOnce 兜底
			expect(
				await bb.events.query({ type: "dispatch_recovered" }),
			).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	test("激活写失败：撤掉刚建的 worktree，不留「有 worktree 没工位」", async () => {
		const { projectDir, bb, cleanup } = await makeCommittedRepo();
		try {
			const goal = await bb.goals.add({ title: "激活会失败" });
			await bb.goals.update(goal.id, { status: "ready" });
			await seedWorkspot(bb, "ws-a", "idle", goal.id);

			const { statuses } = traceSaves(bb, "active");
			const result = await dispatchGoal(bb, goal.id, "ws-a");

			expect(result.ok).toBe(false);
			expect(result.reason).toContain("已回滚");
			// 认领 → 激活写入失败 → 回滚
			expect(statuses).toEqual(["initializing", "active", "idle"]);
			// worktree 真的被撤了，不是只在返回值里说撤了
			expect(existsSync(join(projectDir, "worktrees", "ws-a"))).toBe(false);
			expect((await bb.state.workspots.get("ws-a"))?.status).toBe("idle");
		} finally {
			await cleanup();
		}
	});
});
