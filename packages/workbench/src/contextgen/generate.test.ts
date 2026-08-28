import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench, type TempWorkbench } from "../test/fixtures";
import type { Workspot } from "../types/workspot";
import { generateAllContexts, generateContext } from "./generate";

async function seedWorkspot(
	ws: TempWorkbench,
	id: string,
	goalId: string,
	extra: Partial<Workspot> = {},
): Promise<Workspot> {
	const workspot: Workspot = {
		id,
		branch: `ws/${id}`,
		worktreePath: join("worktrees", id),
		primaryTask: goalId,
		binding: "primary",
		status: "active",
		contextNeeds: { decisions: [], interfaces: [] },
		...extra,
	};
	await ws.bb.state.workspots.save(workspot);
	return workspot;
}

describe("generateContext", () => {
	test("writes .agent-context.md into the workspot worktree", async () => {
		const ws = await makeTempWorkbench();
		try {
			const goal = await ws.bb.goals.add({ title: "实现渲染器" });
			await seedWorkspot(ws, "ws-a", goal.id);

			const result = await generateContext(ws.bb, "ws-a");
			expect(result.ok).toBe(true);

			const file = join(
				ws.projectDir,
				"worktrees",
				"ws-a",
				".agent-context.md",
			);
			const markdown = await readFile(file, "utf8");
			expect(markdown).toContain("实现渲染器");
			expect(markdown).toContain(`（${goal.id}）`);
			expect(markdown).toContain("## 约束");
		} finally {
			await ws.cleanup();
		}
	});

	test("includes decisions and interfaces requested by context_needs", async () => {
		const ws = await makeTempWorkbench();
		try {
			const goal = await ws.bb.goals.add({ title: "消费接口的任务" });
			const decision = await ws.bb.decisions.add({
				title: "只走 Blackboard",
				rationale: "单一数据通道",
				author: "human",
			});
			const contract = join(ws.projectDir, "contracts", "api.md");
			await ws.bb.interfaces.register({
				key: "core/api",
				canonicalPath: "contracts/api.md",
				version: 1,
				publishedBy: "ws-a",
				lastModified: new Date().toISOString(),
				contentHash: "hash-1",
				subscribers: [],
			});
			await seedWorkspot(ws, "ws-a", goal.id, {
				contextNeeds: {
					decisions: [decision.id],
					interfaces: ["core/api"],
				},
			});
			void contract;

			const result = await generateContext(ws.bb, "ws-a");
			expect(result.ok).toBe(true);
			const markdown = await readFile(result.path as string, "utf8");
			expect(markdown).toContain("只走 Blackboard");
			expect(markdown).toContain("core/api → contracts/api.md（v1）");
			expect(markdown).toContain("文件路径:");
		} finally {
			await ws.cleanup();
		}
	});

	test("missing workspot or missing task goal reports failure without throwing", async () => {
		const ws = await makeTempWorkbench();
		try {
			const noWorkspot = await generateContext(ws.bb, "ws-ghost");
			expect(noWorkspot.ok).toBe(false);

			await seedWorkspot(ws, "ws-a", "g-ghost");
			const noGoal = await generateContext(ws.bb, "ws-a");
			expect(noGoal.ok).toBe(false);
			expect(noGoal.reason).toContain("g-ghost");
		} finally {
			await ws.cleanup();
		}
	});
});

describe("generateAllContexts", () => {
	test("refreshes every workspot and reports unresolvable ones", async () => {
		const ws = await makeTempWorkbench();
		try {
			const goal = await ws.bb.goals.add({ title: "任务 A" });
			await seedWorkspot(ws, "ws-a", goal.id);
			await seedWorkspot(ws, "ws-broken", "g-ghost");

			const results = await generateAllContexts(ws.bb);
			expect(results).toHaveLength(2);
			const ok = results.find((r) => r.workspotId === "ws-a");
			const broken = results.find((r) => r.workspotId === "ws-broken");
			expect(ok?.ok).toBe(true);
			expect(broken?.ok).toBe(false);
		} finally {
			await ws.cleanup();
		}
	});
});
