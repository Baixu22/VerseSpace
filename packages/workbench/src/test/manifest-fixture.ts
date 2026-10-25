import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyCheckpoint } from "../runtime/verify-checkpoint";
import { seedArtifactUse } from "./artifact-use-fixture";
import { targetGit } from "./target-artifact-fixture";

export async function seedPortableArtifact() {
	const ws = await seedArtifactUse();
	await writeFile(
		join(ws.projectDir, ".gitignore"),
		".workbench/\nreport.json\nmanifest.json\n",
	);
	await writeFile(
		join(ws.projectDir, "config.json"),
		'{"apiKey":"SENTINEL_SECRET_CONFIG"}',
	);
	targetGit(
		ws.projectDir,
		"add",
		".gitignore",
		"api.txt",
		"consumer.txt",
		"check.cjs",
		"config.json",
	);
	targetGit(ws.projectDir, "commit", "-qm", "manifest baseline");
	const root = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
	const draft = {
		...root,
		lifecycle: "draft" as const,
		assertion: "SENTINEL_SECRET_ASSERTION",
		artifact: { ...root.artifact!, targetRef: "main" },
		verification: {
			...root.verification!,
			command: undefined,
			evidence: {
				...root.verification!.evidence!,
				inputs: ["config.json"],
				fixedFiles: {
					mode: "node-offline-files-v1" as const,
					complete: true as const,
					script: "check.cjs",
				},
			},
		},
	};
	await ws.bb.checkpoints.save(draft, "staging");
	await verifyCheckpoint(ws.bb, "cp", []);
	return ws;
}
