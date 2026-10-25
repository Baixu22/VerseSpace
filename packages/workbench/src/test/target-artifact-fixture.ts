import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyCheckpoint } from "../runtime/verify-checkpoint";
import { checkpointSchema } from "../types/checkpoint";
import { workspotSchema } from "../types/workspot";
import { seedArtifactUse } from "./artifact-use-fixture";

export function targetGit(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		[
			"-c",
			"core.hooksPath=",
			"-c",
			"user.name=test",
			"-c",
			"user.email=test@example.invalid",
			...args,
		],
		{ cwd, encoding: "utf8", stdio: "pipe" },
	).trim();
}

export async function seedTargetArtifact(fixed = true) {
	const ws = await seedArtifactUse();
	await writeFile(
		join(ws.projectDir, ".gitignore"),
		".workbench/\nreport.json\nworktree/\n",
	);
	await writeFile(join(ws.projectDir, "config.json"), "{}");
	targetGit(
		ws.projectDir,
		"add",
		".gitignore",
		"api.txt",
		"consumer.txt",
		"check.cjs",
		"config.json",
		"metadata.txt",
	);
	targetGit(ws.projectDir, "commit", "-qm", "target baseline");
	const side = join(ws.projectDir, "worktree");
	targetGit(ws.projectDir, "worktree", "add", "--detach", side, "HEAD");
	await ws.bb.state.workspots.save(
		workspotSchema.parse({
			id: "side",
			branch: "side",
			worktreePath: side,
			status: "active",
			primaryTask: ws.goalId,
		}),
	);
	const original = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
	const cp = checkpointSchema.parse({
		...original,
		id: "target-cp",
		lifecycle: "draft",
		workspot: "side",
		artifact: { ...original.artifact!, targetRef: "main" },
		verification: {
			...original.verification!,
			command: fixed ? undefined : original.verification!.command,
			evidence: {
				...original.verification!.evidence!,
				inputs: ["check.cjs", "config.json"],
				...(fixed
					? {
							fixedFiles: {
								mode: "node-offline-files-v1",
								script: "check.cjs",
								complete: true,
							},
						}
					: {}),
			},
		},
		verificationResult: undefined,
		verificationBinding: undefined,
		artifactBinding: undefined,
	});
	await ws.bb.checkpoints.save(cp, "staging");
	await verifyCheckpoint(ws.bb, cp.id, []);
	return { ...ws, side, checkpointId: cp.id };
}
