import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { checkpointSchema } from "../types/checkpoint";
import { workspotSchema } from "../types/workspot";
import { runOnce } from "./index";
import { reviewCheckpoint } from "./review";

function gitCli(root: string, args: string[]): void {
	execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

async function seedRepoWithGoal(withGit = true): Promise<{
	ws: Awaited<ReturnType<typeof makeTempWorkbench>>;
	goalId: string;
	check: { command: string; strategy: "test" };
}> {
	const ws = await makeTempWorkbench();
	await writeFile(join(ws.projectDir, "answer.txt"), "correct", "utf8");
	await writeFile(
		join(ws.projectDir, "check.cjs"),
		'const fs = require("node:fs");\n' +
			'if (fs.readFileSync("answer.txt", "utf8") !== "correct") {\n' +
			'  console.error("answer regressed");\n' +
			"  process.exit(1);\n" +
			"}\n" +
			'console.log("one assertion passed");\n',
		"utf8",
	);
	if (withGit) {
		gitCli(ws.projectDir, ["init", "-q", "-b", "main"]);
		gitCli(ws.projectDir, ["config", "user.email", "t@example.com"]);
		gitCli(ws.projectDir, ["config", "user.name", "test"]);
		gitCli(ws.projectDir, ["add", "."]);
		gitCli(ws.projectDir, ["commit", "-q", "-m", "init"]);
	}
	const goal = await ws.bb.goals.add(
		{ title: "answer stays correct" },
		"in_progress",
	);
	await ws.bb.state.workspots.save(
		workspotSchema.parse({
			id: "ws-probe",
			branch: "probe",
			worktreePath: ws.projectDir,
			primaryTask: goal.id,
			status: "active",
		}),
	);
	await ws.bb.checkpoints.save(
		checkpointSchema.parse({
			id: "cp-probe",
			goal: goal.id,
			workspot: "ws-probe",
			timestamp: new Date().toISOString(),
			lifecycle: "draft",
			assertion: "answer stays correct",
			verification: {
				strategy: "test",
				command: `"${process.execPath}" check.cjs`,
			},
		}),
		"staging",
	);
	return {
		ws,
		goalId: goal.id,
		check: {
			command: `"${process.execPath}" check.cjs`,
			strategy: "test",
		},
	};
}

describe("验证时效性端到端（runOnce）", () => {
	test("检查在断言后改坏输入：保留通过事实但不绑定、不完成、不自动重跑", async () => {
		const { ws, goalId } = await seedRepoWithGoal();
		try {
			await writeFile(
				join(ws.projectDir, "check.cjs"),
				'const fs=require("node:fs"); if(fs.readFileSync("answer.txt","utf8")!=="correct")process.exit(1); fs.writeFileSync("answer.txt","regression");',
			);
			const first = await runOnce(ws.bb);
			expect(first.verifications[0]?.result.status).toBe("passed");
			const cp = (await ws.bb.checkpoints.scanZone("staging"))[0]!;
			expect(cp.lifecycle).toBe("awaiting_review");
			expect(cp.verificationResult?.status).toBe("passed");
			expect(cp.verificationBinding).toBeUndefined();
			expect(cp.verificationBindingIssue).toContain("验证期间代码状态变化");
			expect((await runOnce(ws.bb)).verifications).toHaveLength(0);
			expect((await ws.bb.goals.get(goalId))?.status).toBe("in_progress");
			expect(await ws.bb.checkpoints.scanZone("verified")).toHaveLength(0);
		} finally {
			await ws.cleanup();
		}
	});

	test("新验证无法采集 Git 状态：待审查且不能通过人工入口静默放行", async () => {
		const { ws, goalId } = await seedRepoWithGoal(false);
		try {
			await runOnce(ws.bb);
			const cp = (await ws.bb.checkpoints.scanZone("staging"))[0]!;
			expect(cp.lifecycle).toBe("awaiting_review");
			expect(cp.verificationBindingIssue).toContain("未知");
			expect(cp.verificationResult?.status).toBe("passed");
			const review = await reviewCheckpoint(ws.bb, cp.id, true);
			expect(review.ok).toBe(false);
			expect(review.reason).toContain("未知");
			expect((await ws.bb.goals.get(goalId))?.status).toBe("in_progress");
			expect((await reviewCheckpoint(ws.bb, cp.id, false)).ok).toBe(true);
		} finally {
			await ws.cleanup();
		}
	});

	test("验证通过且代码未变：正常推进 applied → done", async () => {
		const { ws, goalId } = await seedRepoWithGoal();
		try {
			await runOnce(ws.bb);
			const verified = (await ws.bb.checkpoints.scanZone("verified"))[0];
			expect(verified?.lifecycle).toBe("verified");
			expect(verified?.verificationBinding?.commit).toBeTruthy();
			await runOnce(ws.bb);
			await runOnce(ws.bb);
			expect((await ws.bb.goals.get(goalId))?.status).toBe("done");
		} finally {
			await ws.cleanup();
		}
	});

	test("验证后代码变化：退回 staging 重验，目标不完成", async () => {
		const { ws, goalId } = await seedRepoWithGoal();
		try {
			await runOnce(ws.bb);
			const verified = (await ws.bb.checkpoints.scanZone("verified"))[0];
			expect(verified?.verificationBinding?.commit).toBeTruthy();

			// 验证之后代码继续变（人编辑/另一个 agent/合并的替身）
			await writeFile(join(ws.projectDir, "answer.txt"), "regression", "utf8");

			const second = await runOnce(ws.bb);
			// 原实现会把 verified 推进为 applied；现在必须先失效
			const staging = (await ws.bb.checkpoints.scanZone("staging"))[0];
			expect(staging?.lifecycle).toBe("draft");
			expect(staging?.verificationInvalidatedReason).toContain("answer.txt");
			expect(staging?.verificationInvalidatedAt).toBeTruthy();
			expect((await ws.bb.checkpoints.scanZone("verified")).length).toBe(0);
			expect((await ws.bb.goals.get(goalId))?.status).toBe("in_progress");
			expect(
				second.notifications.some((n) => n.message.includes("验证已过期")),
			).toBe(true);
			expect(
				await ws.bb.events.query({ type: "verification_invalidated" }),
			).toHaveLength(1);

			// 下一轮按退回的 checkpoint 重跑检查：这次真的失败了，进 failed 区
			await runOnce(ws.bb);
			const failed = (await ws.bb.checkpoints.scanZone("failed"))[0];
			expect(failed?.verificationResult?.status).toBe("failed");
			expect((await ws.bb.goals.get(goalId))?.status).toBe("in_progress");
		} finally {
			await ws.cleanup();
		}
	});

	test("退回重验后修复代码：第二轮验证通过并重新绑定，目标达成", async () => {
		const { ws, goalId } = await seedRepoWithGoal();
		try {
			await runOnce(ws.bb);
			await writeFile(join(ws.projectDir, "answer.txt"), "regression", "utf8");
			await runOnce(ws.bb);
			expect((await ws.bb.checkpoints.scanZone("staging"))[0]?.lifecycle).toBe(
				"draft",
			);

			// 修复到检查能通过的状态
			await writeFile(join(ws.projectDir, "answer.txt"), "correct", "utf8");
			await runOnce(ws.bb); // 重跑检查 → 再次 verified（重新采集绑定）
			const reverified = (await ws.bb.checkpoints.scanZone("verified"))[0];
			expect(reverified?.lifecycle).toBe("verified");
			expect(reverified?.verificationBinding?.commit).toBeTruthy();
			// 失效读数保留为历史，不随重验清除
			expect(reverified?.verificationInvalidatedReason).toBeTruthy();

			await runOnce(ws.bb); // applied
			await runOnce(ws.bb); // done
			expect((await ws.bb.goals.get(goalId))?.status).toBe("done");
		} finally {
			await ws.cleanup();
		}
	});
});
