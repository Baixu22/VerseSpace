import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { makeCommittedRepo } from "../test/git-project";
import { createWorktree, type GitRunner } from "./index";
import {
	listWorktrees,
	parseWorktreeList,
	removeWorktree,
	samePath,
	worktreeHoldingBranch,
} from "./worktree";

describe("worktree 清单", () => {
	test("porcelain 文本解析：分支剥掉 refs/heads/，detached 记为 null", () => {
		const entries = parseWorktreeList(
			[
				"worktree D:/repo",
				"HEAD aaaa",
				"branch refs/heads/main",
				"",
				"worktree D:/repo/worktrees/ws-a",
				"HEAD bbbb",
				"detached",
				"",
			].join("\n"),
		);
		expect(entries).toHaveLength(2);
		expect(entries[0]?.branch).toBe("main");
		expect(entries[1]?.branch).toBeNull();
		expect(entries[1]?.path).toBe("D:/repo/worktrees/ws-a");
	});

	test("末块没有结尾空行时仍然解析（不依赖 \\n\\n 分隔）", () => {
		const entries = parseWorktreeList(
			"worktree D:/repo\nHEAD aaaa\nbranch refs/heads/main",
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.branch).toBe("main");
	});

	test("真实仓库：主检出可见，新 worktree 建完后可见且持有其分支", async () => {
		const { projectDir, cleanup } = await makeCommittedRepo();
		try {
			const before = await listWorktrees(projectDir);
			expect(before.ok).toBe(true);
			expect(before.entries).toHaveLength(1);
			expect(before.entries[0]?.branch).toBe("main");

			// 分支空闲时回答 null —— "没人持有"和"问不出来"是两回事
			const free = await worktreeHoldingBranch(projectDir, "ws-a");
			expect(free).toEqual({ ok: true, path: null });

			const created = await createWorktree(
				projectDir,
				join("worktrees", "ws-a"),
				"ws-a",
			);
			expect(created.ok).toBe(true);

			const after = await listWorktrees(projectDir);
			expect(after.entries).toHaveLength(2);
			const holder = await worktreeHoldingBranch(projectDir, "ws-a");
			expect(holder.ok).toBe(true);
			expect(holder.path).not.toBeNull();
			expect(holder.path).toContain("ws-a");
		} finally {
			await cleanup();
		}
	});
});

describe("路径同一性", () => {
	test("相对路径按项目根解析后相等", () => {
		expect(samePath("/repo", "worktrees/ws-a", "/repo/worktrees/ws-a")).toBe(
			true,
		);
		expect(samePath("/repo", "worktrees/ws-a", "/repo/worktrees/ws-b")).toBe(
			false,
		);
	});

	test("尾随分隔符不影响判定", () => {
		expect(samePath("/repo", "/repo/worktrees/ws-a/", "worktrees/ws-a")).toBe(
			true,
		);
	});

	test.skipIf(process.platform !== "win32")(
		"win32 大小写不敏感（同一目录的不同写法）",
		() => {
			expect(
				samePath("D:/repo", "D:/Repo/worktrees/ws-a", "worktrees/ws-a"),
			).toBe(true);
		},
	);
});

describe("移除 worktree", () => {
	test("移除后目录消失，清单里不再出现", async () => {
		const { projectDir, cleanup } = await makeCommittedRepo();
		try {
			await createWorktree(projectDir, join("worktrees", "ws-a"), "ws-a");
			const removed = await removeWorktree(
				projectDir,
				join("worktrees", "ws-a"),
			);
			expect(removed.ok).toBe(true);
			expect(existsSync(join(projectDir, "worktrees", "ws-a"))).toBe(false);
			const inventory = await listWorktrees(projectDir);
			expect(inventory.entries).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	test("拒绝把项目根目录当 worktree 删（防误删用户仓库）", async () => {
		const { projectDir, cleanup } = await makeCommittedRepo();
		try {
			const refused = await removeWorktree(projectDir, ".");
			expect(refused.ok).toBe(false);
			expect(refused.reason).toContain("项目根目录");
			// 仓库本体还在
			expect(existsSync(join(projectDir, "README.md"))).toBe(true);
		} finally {
			await cleanup();
		}
	});

	// TF-0269 (OPEN-7)：prune 的结果以前被整个丢弃——全仓唯一一处不检查 git()
	// 返回值的生产调用点。注入 runner 之后这一分支在本机（禁止子进程）也能验证。
	test("[TF-0269] prune 失败会点名，而移除本身仍报 ok", async () => {
		const originalError = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map((a) => String(a)).join(" "));
		};
		try {
			const calls: string[] = [];
			const fakeGit: GitRunner = async (args) => {
				calls.push(args.join(" "));
				if (args[1] === "prune") {
					return {
						ok: false,
						code: 128,
						stdout: "",
						stderr: "fatal: prune 失败",
					};
				}
				return { ok: true, code: 0, stdout: "", stderr: "" };
			};
			const result = await removeWorktree("D:/repo", "D:/repo/wt-a", {
				runGit: fakeGit,
			});
			// checkout 确实没了，所以移除成功——但陈旧的 git 管理条目必须说出来
			expect(result.ok).toBe(true);
			expect(calls[0]?.startsWith("worktree remove")).toBe(true);
			expect(calls[1]).toBe("worktree prune");
			expect(errors.join("\n")).toContain("worktree prune 失败");
		} finally {
			console.error = originalError;
		}
	});
});
