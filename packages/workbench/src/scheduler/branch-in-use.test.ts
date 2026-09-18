import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createWorktree } from "../git";
import { makeCommittedRepo } from "../test/git-project";
import { dispatchGoal } from "./dispatch";

/** A ready goal plus an idle workspot carrying `branch`. */
async function readyDispatchable(
	bb: Awaited<ReturnType<typeof makeCommittedRepo>>["bb"],
	workspotId: string,
	branch: string,
) {
	const goal = await bb.goals.add({ title: `任务 ${workspotId}` });
	await bb.goals.update(goal.id, { status: "ready" });
	await bb.state.workspots.save({
		id: workspotId,
		branch,
		worktreePath: join("worktrees", workspotId),
		primaryTask: goal.id,
		binding: "primary",
		status: "idle",
		contextNeeds: { decisions: [], interfaces: [] },
	});
	return goal;
}

describe("派发前的分支占用预检（TF-0202）", () => {
	test("两工位抢同一条分支：第二个被结构化拒绝，且不留下 worktree", async () => {
		const { projectDir, bb, cleanup } = await makeCommittedRepo();
		try {
			const first = await readyDispatchable(bb, "ws-a", "shared");
			const second = await readyDispatchable(bb, "ws-b", "shared");

			const dispatched = await dispatchGoal(bb, first.id, "ws-a");
			expect(dispatched.ok).toBe(true);

			const refused = await dispatchGoal(bb, second.id, "ws-b");
			expect(refused.ok).toBe(false);
			expect(refused.error?.code).toBe("branch_in_use");
			expect(refused.error?.branch).toBe("shared");
			// 拒绝发生在 createWorktree 之前：第二个 worktree 根本没被创建
			expect(existsSync(join(projectDir, "worktrees", "ws-b"))).toBe(false);

			const events = await bb.events.query({ type: "dispatch_refused" });
			expect(events).toHaveLength(1);
			const payload = events[0]?.payload as {
				reason: string;
				holder: string;
			};
			expect(payload.reason).toBe("branch_in_use");
			expect(payload.holder).toContain("ws-a");

			const cards = await bb.tribunal.list();
			const card = cards.find((item) => item.subject === "ws-b");
			expect(card?.kind).toBe("workspot_blocked");
			// 卡片以建议收尾，且动作是可执行的换工位派发（TF-0082）
			expect(card?.sbar.recommendation.endsWith("？")).toBe(false);
			expect(card?.action.command).toContain("workbench dispatch");
		} finally {
			await cleanup();
		}
	});

	test("占用者就是这个工位自己的 worktree：重派不被误拒", async () => {
		const { projectDir, bb, cleanup } = await makeCommittedRepo();
		try {
			const goal = await readyDispatchable(bb, "ws-a", "solo");
			// 先手工把 worktree 建好（等价于上一次派发只完成了一半），
			// 此时分支的持有者就是 ws-a 自己。
			const created = await createWorktree(
				projectDir,
				join("worktrees", "ws-a"),
				"solo",
			);
			expect(created.ok).toBe(true);

			const dispatched = await dispatchGoal(bb, goal.id, "ws-a");
			expect(dispatched.ok).toBe(true);
			const refused = await bb.events.query({ type: "dispatch_refused" });
			expect(refused).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	test("分支空闲时预检不产生任何拒绝记录", async () => {
		const { bb, cleanup } = await makeCommittedRepo();
		try {
			const goal = await readyDispatchable(bb, "ws-a", "free-branch");
			const dispatched = await dispatchGoal(bb, goal.id, "ws-a");
			expect(dispatched.ok).toBe(true);
			expect(await bb.events.query({ type: "dispatch_refused" })).toHaveLength(
				0,
			);
		} finally {
			await cleanup();
		}
	});
});
