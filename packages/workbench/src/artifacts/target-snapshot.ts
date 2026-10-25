import { git } from "../git";
import type { ArtifactSnapshot } from "../types/artifact-evidence";
import type { Checkpoint } from "../types/checkpoint";
import { declaredFixedFiles } from "../verifier/isolated-files";

export async function targetSnapshot(
	cwd: string,
	cp: Checkpoint,
): Promise<ArtifactSnapshot["target"]> {
	const ref = cp.artifact?.targetRef;
	if (!ref) return undefined;
	const unknown = (
		reason: string,
	): NonNullable<ArtifactSnapshot["target"]> => ({
		ref,
		status: "unknown",
		reason,
	});
	const commit = await git(
		["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
		cwd,
	);
	if (!commit.ok) return unknown("目标 ref 不可读取");
	const sha = commit.stdout.trim();
	const tree = await git(["rev-parse", `${sha}^{tree}`], cwd);
	if (!tree.ok) return unknown("目标 tree 不可读取");
	const fixed = !!cp.verification?.evidence?.fixedFiles;
	const names = fixed
		? declaredFixedFiles(cp.verification!, cp.artifact!)
		: cp.artifact!.inputs;
	const blobs: Record<string, string | null> = {};
	let inputsMatch = true;
	for (const raw of names) {
		const path = raw.replace(/\\/g, "/").replace(/^\.\//, "");
		const entry = await git(
			["ls-tree", "-z", sha, "--", `:(literal)${path}`],
			cwd,
		);
		if (!entry.ok) return unknown(`目标文件 ${path} 无法测量`);
		const rows = entry.stdout.split("\0").filter(Boolean);
		if (!rows.length) blobs[path] = null;
		else {
			const record = rows[0]!.match(
				/^(100644|100755) blob ([a-f0-9]+)\t(.*)$/s,
			);
			if (rows.length !== 1 || !record || record[3] !== path)
				return unknown(`目标 ${path} 不是可核对的普通文件`);
			blobs[path] = record[2]!;
		}
		if (
			cp.artifact!.inputs.some(
				(input) => input.replace(/\\/g, "/").replace(/^\.\//, "") === path,
			)
		) {
			const local = await git(["hash-object", "--", path], cwd);
			if (!blobs[path] || !local.ok || local.stdout.trim() !== blobs[path])
				inputsMatch = false;
		}
	}
	return {
		ref,
		commit: sha,
		tree: tree.stdout.trim(),
		status: "available",
		inputsMatch,
		...(fixed ? { scope: "declared-files-v1" as const, blobs } : {}),
	};
}
