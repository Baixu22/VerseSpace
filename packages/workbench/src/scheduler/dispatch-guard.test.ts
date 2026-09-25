import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blackboard } from "../blackboard";
import { runOnce } from "../runtime";
import { commitOnBranch, makeCommittedRepo } from "../test/git-project";
import { createUiServer } from "../ui/server";
import { type DispatchResult, dispatchGoal } from "./dispatch";

/**
 * TF-0258 (F-07): `/api/dispatch` is a CLI-equivalent endpoint the dashboard
 * never calls (workspace-routes.ts:1-6). This helper is a ROUTE CONTRACT path —
 * it proves the endpoint, not a product surface; see the category note at the
 * top of ui/server.test.ts. Do not count it as "the panel can dispatch".
 */
async function dispatchHttp(
	bb: Blackboard,
	goalId: string,
	workspotId: string,
): Promise<DispatchResult> {
	const server = await createUiServer(bb, 0);
	try {
		const response = await fetch(
			`http://127.0.0.1:${server.port}/api/dispatch`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-workbench-token": server.authToken,
				},
				body: JSON.stringify({ goalId, workspotId }),
			},
		);
		return (await response.json()) as DispatchResult;
	} finally {
		server.stop(true);
	}
}

describe("派发的预检与故障告警", () => {
	test.each([
		"overlap",
		"unavailable",
	] as const)("单分支派发仍检查写集；预检状态 %s 不阻塞开工", async (mode) => {
		const ws = await makeCommittedRepo();
		const error = spyOn(console, "error").mockImplementation(() => {});
		try {
			const goal = await ws.bb.goals.add({ title: "继续工作" });
			await ws.bb.goals.update(goal.id, { status: "ready" });
			await ws.bb.state.workspots.save({
				id: "incoming",
				branch: "incoming",
				worktreePath: "worktrees/incoming",
				primaryTask: goal.id,
				binding: "primary",
				status: "idle",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			if (mode === "unavailable") {
				ws.bb.sessions.list = async () => {
					throw new Error("cannot read writers");
				};
			} else {
				for (const writer of ["a", "b"]) {
					await ws.bb.sessions.register(writer, "agent", writer);
					await ws.bb.sessions.recordActivity(writer, {
						activity: "write",
						agent: writer,
						used: [],
						generated: [{ path: "README.md", version: writer }],
					});
				}
			}
			expect((await dispatchGoal(ws.bb, goal.id, "incoming")).ok).toBe(true);
			if (mode === "unavailable") {
				expect(error).toHaveBeenCalledWith(
					expect.stringContaining("合并预检未完成"),
					expect.any(Error),
				);
			} else {
				expect(
					(await ws.bb.tribunal.list()).some(
						(item) => item.kind === "write_overlap_rare",
					),
				).toBe(true);
			}
		} finally {
			error.mockRestore();
			await ws.cleanup();
		}
	});

	test.each([
		"auto",
		"manual",
		"http",
	] as const)("%s 派发前检测真实合并冲突并提示，继续派发", async (mode) => {
		const { projectDir, bb, cleanup } = await makeCommittedRepo();
		try {
			// 分支名故意不带斜杠：本机 git 2.55 无法创建嵌套 ref
			// （`refs/heads/<dir>/<name>` 静默丢失），带斜杠的用例在本环境必红。
			// 两条分支都改了 README 的同一行 → merge-tree 必然报冲突
			await commitOnBranch(projectDir, "ws-a", "# repo\n\nfrom A\n");
			await commitOnBranch(projectDir, "ws-b", "# repo\n\nfrom B\n");

			const goal = await bb.goals.add({ title: "第三个写者" });
			await bb.goals.update(goal.id, { status: "ready" });
			await bb.state.workspots.save({
				id: "ws-a",
				branch: "ws-a",
				worktreePath: join("worktrees", "ws-a"),
				primaryTask: "goal-a",
				binding: "primary",
				status: "active",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			await bb.state.workspots.save({
				id: "ws-b",
				branch: "ws-b",
				worktreePath: join("worktrees", "ws-b"),
				primaryTask: goal.id,
				binding: "primary",
				status: "idle",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			const config = await bb.config.load();
			config.scheduler.policy = "auto";
			await bb.config.save(config);

			const dispatches =
				mode === "auto"
					? (await runOnce(bb)).dispatches
					: [
							mode === "manual"
								? await dispatchGoal(bb, goal.id, "ws-b")
								: await dispatchHttp(bb, goal.id, "ws-b"),
						];
			// 预检不阻塞：派发照常发生
			expect(dispatches).toHaveLength(1);
			expect(dispatches[0]?.ok).toBe(true);

			// 预检本身留下了一次可观测的扫掠
			const sweeps = await bb.events.query({ type: "merge_guard" });
			expect(sweeps).toHaveLength(1);
			expect(
				(sweeps[0]?.payload as { conflicts: number }).conflicts,
			).toBeGreaterThan(0);

			const queued = await bb.tribunal.list();
			const conflict = queued.find(
				(item) => item.kind === "merge_conflict_predicted",
			);
			expect(conflict).toBeDefined();
			expect(conflict?.action.label).toContain("README.md");
			// 卡片必须以建议收尾，不能以问句把推理推回给人（TF-0082）
			expect(conflict?.sbar.recommendation.endsWith("？")).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test.each([
		"auto",
		"manual",
		"http",
	] as const)("%s 派发失败进入裁决队列", async (mode) => {
		const { projectDir, bb, cleanup } = await makeCommittedRepo();
		try {
			const goal = await bb.goals.add({ title: "派发会失败" });
			await bb.goals.update(goal.id, { status: "ready" });
			await bb.state.workspots.save({
				id: "ws-a",
				// 无斜杠：本机 git 2.55 建不了嵌套 ref（见上一条用例）
				branch: "ws-a",
				worktreePath: join("blocked", "ws-a"),
				primaryTask: "g-0",
				binding: "primary",
				status: "idle",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			// 让 worktree 路径被一个普通文件占住 → `git worktree add` 必然失败。
			// 这条失败**没有 error.code**（不是 invalid_branch_name），正是要覆盖
			// 的「未诊断失败」分支：以前它只在事件流里留一行。
			await mkdir(join(projectDir, "blocked"), { recursive: true });
			await writeFile(join(projectDir, "blocked", "ws-a"), "占位\n", "utf8");
			const config = await bb.config.load();
			config.scheduler.policy = "auto";
			await bb.config.save(config);

			const dispatches =
				mode === "auto"
					? (await runOnce(bb)).dispatches
					: [
							mode === "manual"
								? await dispatchGoal(bb, goal.id, "ws-a")
								: await dispatchHttp(bb, goal.id, "ws-a"),
						];
			expect(dispatches).toHaveLength(1);
			expect(dispatches[0]?.ok).toBe(false);
			expect(dispatches[0]?.error).toBeUndefined();

			const events = await bb.events.query({ type: "dispatch_failed" });
			expect(events).toHaveLength(1);

			const queued = await bb.tribunal.list();
			const card = queued.find((item) => item.kind === "dispatch_failed");
			expect(card).toBeDefined();
			expect(card?.subject).toBe(goal.id);
			// 可执行的动作，且不以问句把推理推回给人（TF-0082）
			expect(card?.action.command).toContain(`dispatch ${goal.id}`);
			expect(card?.sbar.recommendation.endsWith("？")).toBe(false);
		} finally {
			await cleanup();
		}
	});
});
