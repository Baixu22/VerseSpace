import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Blackboard, openBlackboard } from "../blackboard";
import { initWorkbench } from "../commands/init";
import { branchNameProblem, normalizeBranchName } from "../git/refname";
import { workspotSchema } from "../types/workspot";
import { dispatchGoal } from "./dispatch";

/**
 * TF-0117（健壮性部分）：不合法的分支名必须在 createWorktree 之前被拦住，
 * 产出结构化错误并进裁决队列，而不是把 git 的 `fatal:` 原样往上抛。
 *
 * 本机实测（2026-09-05，git 2.51.0.windows.1）：含斜杠的分支名 `ws/ws-a`
 * 完全正常，`git worktree add -b ws/ws-a` 成功。所以这里校验的是 git 自己的
 * ref 规则，不是「禁止斜杠」——后者只是某个 git 构建的环境问题，节点原文里
 * 那半边动作按用户裁决不做。
 */

describe("分支名规则（对齐 git check-ref-format）", () => {
	test("合法名字一律放行，含斜杠的层级名也是合法的", () => {
		for (const name of [
			"main",
			"ws-a",
			"ws/ws-a",
			"feat/deep/nested",
			"release-1.2.3",
			"用户分支",
		]) {
			expect(branchNameProblem(name)).toBeNull();
		}
	});

	test("git 会拒绝的每一类都能给出具体原因", () => {
		const cases: Array<[string, string]> = [
			["", "空"],
			["-x", "-"],
			["/x", "/"],
			["x/", "/"],
			["a//b", "//"],
			["a..b", ".."],
			["a.", "."],
			["a@{b", "@{"],
			["@", "@"],
			["HEAD", "HEAD"],
			["a b", "空格"],
			["a~b", "~"],
			["a^b", "^"],
			["a:b", ":"],
			["a?b", "?"],
			["a*b", "*"],
			["a[b", "["],
			["a\\b", "\\"],
			[".hidden", "."],
			["a/.hidden", "."],
			["a/b.lock", ".lock"],
		];
		for (const [name, fragment] of cases) {
			const problem = branchNameProblem(name);
			expect(problem).not.toBeNull();
			expect(problem).toContain(fragment);
		}
	});

	test("和真 git 的判定一致（本机 git 为准）", () => {
		const ask = (name: string) =>
			spawnSync("git", ["check-ref-format", "--branch", name]).status === 0;
		for (const name of ["ws-a", "ws/ws-a", "feat/x"]) {
			expect(branchNameProblem(name) === null).toBe(ask(name));
		}
		for (const name of ["a b", "a~b", "a..b", "a/.h"]) {
			expect(branchNameProblem(name) === null).toBe(ask(name));
		}
	});

	test("归一化只去首尾空白与 refs/heads/ 前缀，不改写非法字符", () => {
		expect(normalizeBranchName("  ws-a  ")).toBe("ws-a");
		expect(normalizeBranchName("refs/heads/ws-a")).toBe("ws-a");
		// 非法字符原样留下，交给校验去拒绝，而不是悄悄换成别的分支
		expect(normalizeBranchName("a b")).toBe("a b");
	});
});

describe("workspot schema 的分支名处理", () => {
	const base = {
		id: "ws-a",
		worktreePath: "worktrees/ws-a",
		primaryTask: "g-0",
		contextNeeds: { decisions: [], interfaces: [] },
	};

	test("归一化后入库", () => {
		expect(
			workspotSchema.parse({ ...base, branch: "  refs/heads/ws-a  " }).branch,
		).toBe("ws-a");
	});

	test("读路径不拒绝历史坏数据：否则一次不透明失败换成另一次", () => {
		// schema 同时是 workspots.get 的解析器。在这里 refine 会让手改过的
		// 工位每次读取都抛 BlackboardDataError，派发连预检都到不了。
		expect(workspotSchema.parse({ ...base, branch: "bad name~1" }).branch).toBe(
			"bad name~1",
		);
	});

	test("含斜杠的分支名仍然可用（不复现的环境问题不写进 schema）", () => {
		expect(workspotSchema.parse({ ...base, branch: "ws/ws-a" }).branch).toBe(
			"ws/ws-a",
		);
	});
});

async function makeCommittedRepo(): Promise<{
	projectDir: string;
	bb: Blackboard;
	cleanup(): Promise<void>;
}> {
	const projectDir = join(
		tmpdir(),
		`workbench-refname-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(projectDir, { recursive: true });
	const run = (args: string[]) => spawnSync("git", args, { cwd: projectDir });
	await writeFile(join(projectDir, "README.md"), "# repo\n", "utf8");
	run(["init", "-q", "-b", "main"]);
	run(["add", "-A"]);
	run([
		"-c",
		"user.email=t@local",
		"-c",
		"user.name=t",
		"commit",
		"-qm",
		"init",
	]);
	await initWorkbench(projectDir);
	return {
		projectDir,
		bb: openBlackboard(join(projectDir, ".workbench")),
		cleanup: () => rm(projectDir, { recursive: true, force: true }),
	};
}

describe("派发前的 ref 预检（TF-0117 验收三）", () => {
	test("坏分支名：结构化错误 + 进裁决队列 + 不建 worktree + 不抛栈", async () => {
		const { projectDir, bb, cleanup } = await makeCommittedRepo();
		try {
			const goal = await bb.goals.add({ title: "被拦住的派发" });
			await bb.goals.update(goal.id, { status: "ready" });
			await bb.state.workspots.save({
				id: "ws-bad",
				// schema 只归一化不拒绝，所以坏名字可以像历史数据那样存在
				branch: "bad name~1",
				worktreePath: join("worktrees", "ws-bad"),
				primaryTask: "g-0",
				binding: "primary",
				status: "idle",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			await bb.state.queue.enqueue(goal.id);

			const result = await dispatchGoal(bb, goal.id, "ws-bad");
			expect(result.ok).toBe(false);
			expect(result.error?.code).toBe("invalid_branch_name");
			expect(result.error?.branch).toBe("bad name~1");
			expect(result.error?.detail).toContain("空格");
			expect(result.reason).toContain("不是合法 git ref");

			// 没有留下半个 worktree，工位与队列都没动
			expect(
				await Bun.file(
					join(projectDir, "worktrees", "ws-bad", ".git"),
				).exists(),
			).toBe(false);
			expect((await bb.state.workspots.get("ws-bad"))?.status).toBe("idle");
			expect(await bb.state.queue.get()).toEqual([goal.id]);

			// 裁决队列拿到一张可执行的卡
			const open = await bb.tribunal.list();
			const card = open.find((item) => item.subject === "ws-bad");
			expect(card).toBeDefined();
			expect(card?.sbar.situation).toContain("不是合法 git ref");
			expect(card?.action.command).toContain("--branch");

			// 事件里留下拒绝的原因，供 stats / 复盘读
			const refused = await bb.events.query({ type: "dispatch_refused" });
			expect(
				refused.some(
					(event) =>
						(event.payload as { reason?: string }).reason ===
						"invalid_branch_name",
				),
			).toBe(true);
		} finally {
			await cleanup();
		}
	});

	/**
	 * ⚠️ 本机（git 2.55.0.windows.3）无法持久化**斜杠嵌套 ref**：`git branch
	 * ws/probe` 返回 0 但 `refs/heads/ws/probe` 静默丢失（宿主钩子会清
	 * `.git/refs` 下的新建文件），于是 `git worktree add -b ws/ws-ok` 报
	 * `fatal: invalid reference: ws/ws-ok`。因此本用例在本机必红，**不是回归**
	 * ——CI（Linux/macOS/Windows 官方 runner）上正常。最小复现：
	 * `git init -q -b main . && git commit --allow-empty -qm x && git branch ws/p
	 * && git for-each-ref`（只列出 refs/heads/main）。
	 * 同一缺陷也让 `dispatch.test.ts` 里用 `ws/...` 的三条用例在本机红；
	 * 新增用例改用无斜杠分支名以绕开它（见 dispatch.test.ts 的 TF-0079 用例）。
	 */
	test("合法分支名照常派发，预检不挡路", async () => {
		const { bb, cleanup } = await makeCommittedRepo();
		try {
			const goal = await bb.goals.add({ title: "正常派发" });
			await bb.goals.update(goal.id, { status: "ready" });
			await bb.state.workspots.save({
				id: "ws-ok",
				branch: "ws/ws-ok",
				worktreePath: join("worktrees", "ws-ok"),
				primaryTask: "g-0",
				binding: "primary",
				status: "idle",
				contextNeeds: { decisions: [], interfaces: [] },
			});
			await bb.state.queue.enqueue(goal.id);

			const result = await dispatchGoal(bb, goal.id, "ws-ok");
			expect(result.ok).toBe(true);
			expect(result.error).toBeUndefined();
		} finally {
			await cleanup();
		}
	});
});
