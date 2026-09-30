import { isAbsolute, join, relative } from "node:path";
import { type GitRunner, git } from "../git";
import { hashFile } from "../hash";
import type { VerificationBinding } from "../types/checkpoint";

export interface BindingOptions {
	/** Ledger writes are not changes to the code under verification. */
	ignorePrefixes?: string[];
	/** Exact declared report output only; never exclude its input siblings. */
	ignorePaths?: string[];
}

export function workbenchPrefixIn(
	worktreePath: string,
	workbenchRoot: string,
): string | null {
	const rel = relative(worktreePath, workbenchRoot).replace(/\\/g, "/");
	return !rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)
		? null
		: rel;
}

/** Capture HEAD and dirty/untracked files; incomplete capture is never intact. */
export async function captureVerificationBinding(
	worktreePath: string,
	runGit: GitRunner = git,
	options: BindingOptions = {},
): Promise<VerificationBinding | null> {
	try {
		const head = await runGit(["rev-parse", "HEAD"], worktreePath);
		if (!head.ok || !head.stdout.trim()) return null;
		// NUL records preserve spaces, Unicode and newlines. Disabling rename
		// folding retains both paths; -uall expands untracked directories.
		const status = await runGit(
			[
				"status",
				"--porcelain=v1",
				"-z",
				"--untracked-files=all",
				"--no-renames",
			],
			worktreePath,
		);
		if (!status.ok) return null;
		const files: VerificationBinding["files"] = {};
		for (const record of status.stdout.split("\0")) {
			if (!record) continue;
			if (record.length < 4 || record[2] !== " ") return null;
			const path = record.slice(3);
			if (options.ignorePaths?.includes(path)) continue;
			if (
				options.ignorePrefixes?.some(
					(prefix) => path === prefix || path.startsWith(`${prefix}/`),
				)
			)
				continue;
			try {
				files[path] = await hashFile(join(worktreePath, path));
			} catch (error) {
				// A declared deletion is a measurable state. Other read failures,
				// including a file vanishing during capture, are unknown.
				if (
					(error as NodeJS.ErrnoException).code !== "ENOENT" ||
					!record.slice(0, 2).includes("D")
				)
					return null;
				files[path] = null;
			}
		}
		const finalHead = await runGit(["rev-parse", "HEAD"], worktreePath);
		if (!finalHead.ok || finalHead.stdout.trim() !== head.stdout.trim())
			return null;
		return { commit: head.stdout.trim(), files };
	} catch {
		return null;
	}
}
