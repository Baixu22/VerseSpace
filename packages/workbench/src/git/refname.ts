/**
 * Branch-name validation (TF-0117).
 *
 * `git worktree add <path> -b <branch>` fails with a bare `fatal:` line when
 * the branch name is not a legal ref, and that line used to travel back to the
 * caller as an opaque string: no code to switch on, nothing in the
 * adjudication queue, and a workspot left half-dispatched. Encoding git's own
 * rules here lets the schema refuse the name at the boundary and lets dispatch
 * explain the refusal in terms a human can act on.
 *
 * The rules mirror `git check-ref-format --branch` (git-check-ref-format(1)).
 * They are deliberately not stricter than git: slashes are legal in branch
 * names, and a validator that banned them would be a workaround for one
 * machine's git build rather than a correctness check. Dispatch still runs the
 * real `git check-ref-format` before creating anything — this predicate exists
 * so the common cases are caught early and named precisely.
 */

/**
 * Trim surrounding whitespace and drop a `refs/heads/` prefix. Nothing else:
 * rewriting illegal characters would silently create a branch the caller did
 * not ask for, which is worse than refusing the name.
 */
export function normalizeBranchName(branch: string): string {
	return branch.trim().replace(/^refs\/heads\//, "");
}

/** Why git would refuse this branch name, or null when it would accept it. */
export function branchNameProblem(branch: string): string | null {
	if (branch.length === 0) {
		return "分支名为空";
	}
	if (branch !== branch.trim()) {
		return "分支名首尾有空白字符";
	}
	if (branch === "@") {
		return "分支名不能是单个 @";
	}
	if (branch === "HEAD") {
		return "分支名不能是 HEAD";
	}
	if (branch.startsWith("-")) {
		return "分支名不能以 - 开头（会被当成命令行选项）";
	}
	if (branch.startsWith("/") || branch.endsWith("/")) {
		return "分支名不能以 / 开头或结尾";
	}
	if (branch.includes("//")) {
		return "分支名不能含连续的 //";
	}
	if (branch.endsWith(".")) {
		return "分支名不能以 . 结尾";
	}
	if (branch.includes("..")) {
		return "分支名不能含连续的两个点 ..";
	}
	if (branch.includes("@{")) {
		return "分支名不能含 @{";
	}
	// Checked by code point rather than a regex range: the interesting cases
	// here ARE control characters, and a regex literal containing them trips
	// lint/suspicious/noControlCharactersInRegex for good reason elsewhere.
	const FORBIDDEN = new Set([..." ~^:?*[\\"]);
	for (const char of branch) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) {
			return "分支名不能含控制字符";
		}
		if (FORBIDDEN.has(char)) {
			return `分支名不能含 ${char === " " ? "空格" : char}`;
		}
	}
	for (const part of branch.split("/")) {
		if (part.length === 0) {
			return "分支名不能含空的层级";
		}
		if (part.startsWith(".")) {
			return `层级 ${part} 不能以 . 开头`;
		}
		if (part.endsWith(".lock")) {
			return `层级 ${part} 不能以 .lock 结尾`;
		}
	}
	return null;
}
