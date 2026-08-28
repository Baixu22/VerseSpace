import { spawn } from "node:child_process";
import { isAbsolute, join } from "node:path";
import { pathExists } from "../fs/atomic";

export interface GitResult {
	ok: boolean;
	stdout: string;
	stderr: string;
}

/** Run git with captured output; never throws. */
export function git(args: string[], cwd: string): Promise<GitResult> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd, shell: false });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("close", (code) => {
			resolve({ ok: code === 0, stdout, stderr });
		});
		child.on("error", (error) => {
			resolve({ ok: false, stdout, stderr: String(error) });
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
