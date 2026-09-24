import { git } from "../../git";
import { branchNameProblem } from "../../git/refname";

/**
 * Refuse an unusable branch name before anything is created (TF-0117).
 *
 * Two layers on purpose: the local predicate names the problem precisely and
 * costs nothing, and `git check-ref-format --branch` is the authority — a git
 * build that refuses a name our rules allow still gets caught, and the failure
 * is a structured result rather than a bare `fatal:` line from
 * `git worktree add`.
 */
export async function checkBranchName(
	projectRoot: string,
	branch: string,
): Promise<string | null> {
	const problem = branchNameProblem(branch);
	if (problem !== null) {
		return problem;
	}
	const check = await git(
		["check-ref-format", "--branch", branch],
		projectRoot,
	);
	if (check.ok) {
		return null;
	}
	return (
		check.stderr.trim() ||
		`git check-ref-format 拒绝了分支名（退出码 ${check.code ?? "未知"}）`
	);
}
