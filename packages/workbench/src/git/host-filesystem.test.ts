import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeCommittedRepo } from "../test/git-project";
import {
	HOST_GUARD_ENV,
	hostFilesystemGuardReason,
	isReadOnlyGitCommand,
	probeHostFilesystem,
	resetHostFilesystemProbe,
} from "./host-filesystem";
import { git } from "./index";

const previousMode = process.env[HOST_GUARD_ENV];

function setMode(mode: string | undefined): void {
	if (mode === undefined) delete process.env[HOST_GUARD_ENV];
	else process.env[HOST_GUARD_ENV] = mode;
	resetHostFilesystemProbe();
}

beforeEach(() => setMode(undefined));

afterEach(() => {
	setMode(previousMode);
});

describe("宿主文件系统探针", () => {
	test("本宿主保留「非空目录不可删除」语义：哨兵存活 → clean", () => {
		const probe = probeHostFilesystem();
		expect(probe.verdict).toBe("clean");
		expect(probe.sentinelSurvived).toBe(true);
		expect(probe.nonEmptyDirectoryRemoved).toBe(false);
	});

	test("force-unsafe 只改判定，不做模块归因", () => {
		setMode("force-unsafe");
		const probe = probeHostFilesystem();
		expect(probe.verdict).toBe("unsafe");
		expect(probe.nonEmptyDirectoryRemoved).toBe(true);
	});
});

describe("只读判定（判定不出来一律按可写处理）", () => {
	test("读命令放行", () => {
		expect(isReadOnlyGitCommand(["rev-parse", "HEAD"])).toBe(true);
		expect(isReadOnlyGitCommand(["status"])).toBe(true);
		expect(isReadOnlyGitCommand(["--no-pager", "log", "-1"])).toBe(true);
		expect(isReadOnlyGitCommand(["-c", "user.name=t", "log", "-1"])).toBe(true);
		expect(isReadOnlyGitCommand(["-C", "D:/repo", "diff", "HEAD"])).toBe(true);
		expect(
			isReadOnlyGitCommand(["merge-tree", "--write-tree", "HEAD", "HEAD"]),
		).toBe(true);
		expect(isReadOnlyGitCommand(["for-each-ref"])).toBe(true);
	});

	test("列表形态的动词放行", () => {
		expect(isReadOnlyGitCommand(["branch"])).toBe(true);
		expect(isReadOnlyGitCommand(["branch", "-a"])).toBe(true);
		expect(isReadOnlyGitCommand(["branch", "--list", "ws/*"])).toBe(true);
		expect(isReadOnlyGitCommand(["tag", "--list"])).toBe(true);
		expect(isReadOnlyGitCommand(["remote", "-v"])).toBe(true);
		expect(isReadOnlyGitCommand(["config", "--get", "user.name"])).toBe(true);
		expect(isReadOnlyGitCommand(["stash", "list"])).toBe(true);
		expect(isReadOnlyGitCommand(["worktree", "list"])).toBe(true);
		expect(isReadOnlyGitCommand(["submodule", "status"])).toBe(true);
	});

	test("写命令一律拦截", () => {
		expect(isReadOnlyGitCommand(["rm", "--", "src/delete.txt"])).toBe(false);
		expect(isReadOnlyGitCommand(["rm", "--cached", "--", "x"])).toBe(false);
		expect(isReadOnlyGitCommand(["switch", "main"])).toBe(false);
		expect(isReadOnlyGitCommand(["checkout", "main"])).toBe(false);
		expect(isReadOnlyGitCommand(["reset", "--hard"])).toBe(false);
		expect(isReadOnlyGitCommand(["commit", "-m", "x"])).toBe(false);
		expect(isReadOnlyGitCommand(["add", "-A"])).toBe(false);
		expect(isReadOnlyGitCommand(["init", "-q"])).toBe(false);
		expect(isReadOnlyGitCommand(["update-ref", "refs/heads/x", "HEAD"])).toBe(
			false,
		);
		expect(isReadOnlyGitCommand(["worktree", "add", "-b", "b", "p"])).toBe(
			false,
		);
		expect(isReadOnlyGitCommand(["stash", "push", "-u"])).toBe(false);
		expect(isReadOnlyGitCommand(["branch", "-d", "x"])).toBe(false);
		expect(isReadOnlyGitCommand(["branch", "ws/new"])).toBe(false);
		expect(isReadOnlyGitCommand(["config", "user.name", "x"])).toBe(false);
		expect(isReadOnlyGitCommand([])).toBe(false);
	});
});

describe("执行闸门", () => {
	test("宿主干净时零变化：写命令照常跑", async () => {
		const { projectDir, cleanup } = await makeCommittedRepo();
		try {
			await writeFile(join(projectDir, "note.txt"), "x\n", "utf8");
			const added = await git(["add", "note.txt"], projectDir);
			expect(added.ok).toBe(true);
			expect(added.stderr).toBe("");
			expect(
				hostFilesystemGuardReason(["rm", "--", "note.txt"]),
			).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	test("宿主被判定不干净时：写命令被拒，仓库文件一个不动", async () => {
		const { projectDir, cleanup } = await makeCommittedRepo();
		try {
			setMode("force-unsafe");
			const blocked = await git(["rm", "--", "README.md"], projectDir);
			expect(blocked.ok).toBe(false);
			expect(blocked.code).toBeNull();
			expect(blocked.stderr).toContain("TF-0173");
			expect(blocked.stderr).toContain(HOST_GUARD_ENV);
			// 静默损坏换成开口拒绝：受影响文件与 ref 都还在
			expect(existsSync(join(projectDir, "README.md"))).toBe(true);
			expect(
				existsSync(join(projectDir, ".git", "refs", "heads", "main")),
			).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("宿主被判定不干净时：只读命令仍放行（诊断不受影响）", async () => {
		const { projectDir, cleanup } = await makeCommittedRepo();
		try {
			setMode("force-unsafe");
			const head = await git(["rev-parse", "HEAD"], projectDir);
			expect(head.ok).toBe(true);
			expect(head.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			await cleanup();
		}
	});

	test("off 显式关闭闸门", () => {
		setMode("off");
		expect(hostFilesystemGuardReason(["rm", "--", "x"])).toBeUndefined();
	});
});
