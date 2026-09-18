/**
 * Worktree inventory and teardown (TF-0202).
 *
 * `createWorktree` could already bind a checkout to a branch; what it could
 * not do was answer "who is already holding this branch?". Without that
 * question, a dispatch whose branch was already checked out somewhere else
 * failed inside `git worktree add` and travelled back as a bare `fatal:` line,
 * exactly the shape TF-0117 removed for branch names. These primitives make
 * the answer data, so dispatch can refuse before anything is created.
 *
 * Every function keeps the module's standing contract: `git()` never throws,
 * and neither do these — a failure is a value (`ok: false` plus a reason), not
 * an exception. Callers decide whether an unreadable inventory means "refuse"
 * or "proceed with a warning"; the git layer does not make that call.
 */

import { resolve } from "node:path";
import { git } from "./index";
import { normalizeBranchName } from "./refname";

export interface WorktreeEntry {
	/** Absolute path of the checkout, as git reports it. */
	path: string;
	/** Short branch name (`refs/heads/` stripped), or null for a detached HEAD. */
	branch: string | null;
	head: string | null;
}

export interface WorktreeListResult {
	ok: boolean;
	entries: WorktreeEntry[];
	reason?: string;
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * Exported for tests and for callers that already have the text (for example a
 * fixture that wants to assert on git's own words). Blocks are separated by a
 * blank line, but a block also ends when the next `worktree ` line starts, so
 * a git build that omits the trailing blank line still parses.
 */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
	const entries: WorktreeEntry[] = [];
	let current: WorktreeEntry | null = null;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			if (current) entries.push(current);
			current = {
				path: line.slice("worktree ".length).trim(),
				branch: null,
				head: null,
			};
			continue;
		}
		if (!current) continue;
		if (line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length).trim();
		} else if (line.startsWith("branch ")) {
			current.branch = normalizeBranchName(line.slice("branch ".length).trim());
		}
	}
	if (current) entries.push(current);
	return entries;
}

/** Every worktree git knows about for this repository, main checkout included. */
export async function listWorktrees(
	projectRoot: string,
): Promise<WorktreeListResult> {
	const result = await git(["worktree", "list", "--porcelain"], projectRoot);
	if (!result.ok) {
		return {
			ok: false,
			entries: [],
			reason:
				result.stderr.trim() ||
				`git worktree list 失败（退出码 ${result.code ?? "未知"}）`,
		};
	}
	return { ok: true, entries: parseWorktreeList(result.stdout) };
}

/**
 * Path of the worktree currently holding `branch`, or null when the branch is
 * free (or does not exist yet). `ok: false` means the question could not be
 * answered — not that the branch is free.
 */
export async function worktreeHoldingBranch(
	projectRoot: string,
	branch: string,
): Promise<{ ok: boolean; path: string | null; reason?: string }> {
	const inventory = await listWorktrees(projectRoot);
	if (!inventory.ok) {
		return { ok: false, path: null, reason: inventory.reason };
	}
	const wanted = normalizeBranchName(branch);
	const holder = inventory.entries.find((entry) => entry.branch === wanted);
	return { ok: true, path: holder?.path ?? null };
}

/**
 * Compare two paths for "same checkout".
 *
 * Both sides are absolutized against `projectRoot` first, because git reports
 * absolute paths while a workspot stores a project-relative one. Windows gets a
 * case-insensitive comparison and slash normalization; on POSIX the comparison
 * stays case-sensitive, since there two paths differing only in case really are
 * different directories.
 */
export function samePath(projectRoot: string, a: string, b: string): boolean {
	const norm = (value: string) => {
		const absolute = resolve(projectRoot, value).replace(/\\/g, "/");
		return process.platform === "win32"
			? absolute.toLowerCase().replace(/\/+$/, "")
			: absolute.replace(/\/+$/, "");
	};
	return norm(a) === norm(b);
}

/**
 * Remove a worktree and prune git's bookkeeping.
 *
 * The `projectRoot` guard is not defensive noise: a workspot whose
 * `worktreePath` was mis-set to the project root would otherwise delete the
 * user's repository. Rust's `remove_worktree` carries the same refusal.
 */
export async function removeWorktree(
	projectRoot: string,
	worktreePath: string,
	options: { force?: boolean } = {},
): Promise<{ ok: boolean; path: string; reason?: string }> {
	const path = resolve(projectRoot, worktreePath);
	if (samePath(projectRoot, path, projectRoot)) {
		return {
			ok: false,
			path,
			reason: `拒绝删除 ${path}：路径等于项目根目录`,
		};
	}
	const args = ["worktree", "remove", path];
	if (options.force) args.push("--force");
	const result = await git(args, projectRoot);
	await git(["worktree", "prune"], projectRoot);
	if (!result.ok) {
		return {
			ok: false,
			path,
			reason:
				result.stderr.trim() ||
				`git worktree remove 失败（退出码 ${result.code ?? "未知"}）`,
		};
	}
	return { ok: true, path };
}
