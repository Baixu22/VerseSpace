import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { pathExists } from "../fs/atomic";
import { hostFilesystemGuardReason } from "./host-filesystem";

export interface GitResult {
	ok: boolean;
	/** Exit code. Some git verbs encode the answer here: `merge-tree` exits
	 * 1 for "they conflict", which is a result, not a failure. */
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * The shape of `git()` as a value, so a caller can accept an injected runner.
 *
 * TF-0269: this exists for the same reason ADR-0020 made `classify.mjs` a pure
 * function — a host that forbids child processes (this repo's agent sandbox is
 * one) cannot verify any branch that needs a real `git`. A caller that only
 * *interprets* git's answer takes the runner as a parameter and defaults to the
 * real one, so the interpretation is testable everywhere the code runs.
 */
export type GitRunner = (
	args: string[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
) => Promise<GitResult>;

/**
 * Run git with captured output; never throws.
 *
 * `env` replaces the child environment when provided. Agent hosts often inject
 * GIT_AUTHOR_NAME / GIT_COMMITTER_NAME (and the EMAIL twins), which outrank
 * `git config user.name` — tests that assert on authors must pin identity
 * through this parameter.
 */
export function git(
	args: string[],
	cwd: string,
	env?: NodeJS.ProcessEnv,
): Promise<GitResult> {
	// 宿主把「非空目录删除」变成成功时，git 的空父目录清理会连带删除兄弟文件与
	// ref（TF-0173）。只读命令照常放行，可写命令改成一个显式失败——把静默损坏
	// 换成开口拒绝。
	const refused = hostFilesystemGuardReason(args);
	if (refused) {
		return Promise.resolve({
			ok: false,
			code: null,
			stdout: "",
			stderr: refused,
		});
	}
	return new Promise((resolve) => {
		const child = spawn("git", args, {
			cwd,
			shell: false,
			env: env ?? process.env,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("close", (code) => {
			resolve({ ok: code === 0, code, stdout, stderr });
		});
		child.on("error", (error) => {
			resolve({ ok: false, code: null, stdout, stderr: String(error) });
		});
	});
}

/** Resolve a (possibly worktree-relative) path against the project root. */
export function resolveInProject(projectRoot: string, path: string): string {
	return isAbsolute(path) ? path : join(projectRoot, path);
}

/**
 * Create a git worktree holding `branch` at `worktreePath`.
 *
 * - idempotent: an existing checkout of that worktree is left untouched;
 * - tolerant: when the branch already exists it is checked out instead of
 *   created;
 * - requires the repo to have at least one commit (git needs a HEAD to branch
 *   from) — surfaced as a clear failure otherwise.
 */
export async function createWorktree(
	projectRoot: string,
	worktreePath: string,
	branch: string,
): Promise<{ ok: boolean; path: string; reason?: string }> {
	const path = resolveInProject(projectRoot, worktreePath);
	if (await pathExists(join(path, ".git"))) {
		return { ok: true, path };
	}
	let result = await git(["worktree", "add", path, "-b", branch], projectRoot);
	if (!result.ok) {
		const branchCheck = await git(
			["rev-parse", "--verify", "--quiet", branch],
			projectRoot,
		);
		if (branchCheck.ok) {
			result = await git(["worktree", "add", path, branch], projectRoot);
		}
	}
	if (!result.ok) {
		const reason =
			result.stderr.trim() || `git worktree add failed for ${path}`;
		return { ok: false, path, reason };
	}
	return { ok: true, path };
}
