/**
 * Stash outcomes as data (TF-0202).
 *
 * Rust's `stash_pop` returns an enum, not an exit code: a conflict during pop
 * is a normal outcome that leaves the stash entry intact for a retry, while a
 * genuine failure is not. Shelling out and reading `ok` collapses those two
 * into one boolean, which is how "the pop conflicted" turns into "the pop
 * failed" and the entry gets dropped on the floor.
 *
 * The same contract as the rest of `git/`: nothing here throws. A caller that
 * cannot tell conflict from failure is a caller that will silently lose work,
 * so the distinction is part of the return type rather than a comment.
 */

import { git } from "./index";

export type StashOutcome = "nothing" | "clean" | "conflict" | "failed";

export interface StashPushResult {
	ok: boolean;
	/** True when an entry was created; false when there was nothing to save. */
	saved: boolean;
	outcome: StashOutcome;
	reason?: string;
}

/**
 * Push a stash entry capturing tracked changes and untracked files.
 *
 * git reports "no changes" by succeeding with a message on stdout, so the
 * message — not the exit code — is what separates `nothing` from `clean`.
 */
export async function stashPushIncludeUntracked(
	projectRoot: string,
	message: string,
): Promise<StashPushResult> {
	const result = await git(
		["stash", "push", "--include-untracked", "-m", message],
		projectRoot,
	);
	if (!result.ok) {
		return {
			ok: false,
			saved: false,
			outcome: "failed",
			reason:
				result.stderr.trim() ||
				`git stash push 失败（退出码 ${result.code ?? "未知"}）`,
		};
	}
	const saved = !result.stdout.includes("No local changes to save");
	return { ok: true, saved, outcome: saved ? "clean" : "nothing" };
}

/**
 * Pop the most recent stash entry.
 *
 * A conflict is detected by asking git which files are unmerged (`ls-files -u`)
 * rather than by guessing from the exit code: `stash pop` exits non-zero both
 * when it conflicted and when it failed outright, and only the former leaves a
 * stash entry worth retrying.
 */
export async function stashPop(
	projectRoot: string,
): Promise<{ outcome: StashOutcome; reason?: string }> {
	const result = await git(["stash", "pop"], projectRoot);
	if (result.ok) {
		return { outcome: "clean" };
	}
	const unmerged = await git(["ls-files", "-u"], projectRoot);
	if (unmerged.ok && unmerged.stdout.trim() !== "") {
		return {
			outcome: "conflict",
			reason: `stash pop 产生冲突，条目保留：${unmerged.stdout
				.split("\n")
				.filter((line) => line.trim() !== "")
				.slice(0, 5)
				.join("、")}`,
		};
	}
	return {
		outcome: "failed",
		reason:
			result.stderr.trim() ||
			`git stash pop 失败（退出码 ${result.code ?? "未知"}）`,
	};
}
