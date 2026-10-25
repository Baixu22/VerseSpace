import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Blackboard } from "../blackboard";
import { git } from "../git";
import { hashFile, hashText } from "../hash";
import { workspotWorktreePath } from "../runtime/verification-binding";
import {
	type ArtifactSnapshot,
	artifactDeclarationSchema,
} from "../types/artifact-evidence";
import type { Checkpoint } from "../types/checkpoint";
import { evidenceFilePath } from "../verifier/evidence-report";

/** Explicit files are content-addressed even if untracked or ignored by Git. */
export async function captureArtifactSnapshot(
	bb: Blackboard,
	cp: Checkpoint,
): Promise<ArtifactSnapshot | undefined> {
	if (!cp.artifact) return undefined;
	try {
		const worktree = await workspotWorktreePath(bb, cp.workspot);
		if (!worktree) return undefined;
		const cwd = await realpath(worktree);
		const common = await git(["rev-parse", "--git-common-dir"], cwd);
		const head = await git(["rev-parse", "--verify", "HEAD"], cwd);
		if (!common.ok || !head.ok) return undefined;
		const repo = await realpath(resolve(cwd, common.stdout.trim()));
		const files: Record<string, string> = {};
		for (const path of new Set([cp.artifact.path, ...cp.artifact.inputs]))
			files[path] = await hashFile(await evidenceFilePath(cwd, path));
		let target: ArtifactSnapshot["target"];
		if (cp.artifact.targetRef) {
			const ref = cp.artifact.targetRef;
			const commit = await git(
				["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
				cwd,
			);
			if (!commit.ok) return undefined;
			const tree = await git(
				["rev-parse", `${commit.stdout.trim()}^{tree}`],
				cwd,
			);
			if (!tree.ok) return undefined;
			let inputsMatch = true;
			for (const path of cp.artifact.inputs) {
				const blob = await git(
					[
						"rev-parse",
						"--verify",
						`${commit.stdout.trim()}:${path.replace(/\\/g, "/")}`,
					],
					cwd,
				);
				const local = await git(["hash-object", "--", path], cwd);
				if (!blob.ok || !local.ok || blob.stdout.trim() !== local.stdout.trim())
					inputsMatch = false;
			}
			target = {
				ref,
				commit: commit.stdout.trim(),
				tree: tree.stdout.trim(),
				inputsMatch,
			};
		}
		return {
			declarationHash: hashText(
				JSON.stringify(artifactDeclarationSchema.parse(cp.artifact)),
			),
			sampling: "checkpoint-file-sample",
			repo,
			cwd,
			head: head.stdout.trim(),
			files,
			...(target ? { target } : {}),
		};
	} catch {
		return undefined;
	}
}

export function artifactSnapshotDifference(
	before: ArtifactSnapshot,
	after: ArtifactSnapshot | undefined,
): string | null {
	if (!after) return "产物、输入、工位或目标基线不可读取";
	if (
		before.declarationHash &&
		before.declarationHash !== after.declarationHash
	)
		return "产物输入、来源选择或目标声明已变化";
	if (before.repo !== after.repo) return "仓库身份已变化";
	if (before.cwd !== after.cwd) return "执行工位已变化，需在明确的新目录重验";
	if (before.target?.ref !== after.target?.ref) return "交接目标 ref 已变化";
	if (before.target?.tree !== after.target?.tree)
		return `目标基线 ${before.target?.ref} 已推进，不能沿用原工位未变的结论`;
	const paths = new Set([
		...Object.keys(before.files),
		...Object.keys(after.files),
	]);
	for (const path of paths)
		if (before.files[path] !== after.files[path])
			return `声明依赖或产物 ${path} 版本变化：${before.files[path]?.slice(0, 12) ?? "未知"} → ${after.files[path]?.slice(0, 12) ?? "未知"}`;
	// A commit/stage with identical selected content is not a semantic change.
	return null;
}
