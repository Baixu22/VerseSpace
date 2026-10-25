import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { selectArtifactInputs } from "../artifacts/input-origin";
import {
	captureReturnedInput,
	hashPathClaim,
} from "../blackboard/footprint-sample";
import { hashText } from "../hash";
import { verifyCheckpoint } from "../runtime/verify-checkpoint";
import { initGitFixture, makeTempWorkbench } from "../test/fixtures";
import { checkpointSchema } from "../types/checkpoint";
import { workspotSchema } from "../types/workspot";
export async function seedArtifactUse(
	mode: "observed" | "sampled" | "unknown" | "legacy" = "observed",
) {
	const ws = await makeTempWorkbench();
	initGitFixture(ws.projectDir);
	await writeFile(join(ws.projectDir, "api.txt"), "v1");
	await writeFile(join(ws.projectDir, "consumer.txt"), "v1");
	await writeFile(join(ws.projectDir, "metadata.txt"), "metadata");
	await writeFile(
		join(ws.projectDir, "check.cjs"),
		`const fs=require("node:fs");const api=fs.readFileSync("api.txt","utf8");const consumer=fs.readFileSync("consumer.txt","utf8");const ok=api===consumer || consumer==="*";fs.writeFileSync("report.json",JSON.stringify({numTotalTests:1,numPassedTests:+ok,numFailedTests:+!ok,numPendingTests:0,success:ok,testResults:[{assertionResults:[{fullName:"contract",status:ok?"passed":"failed"}]}]}));process.exitCode=ok?0:1;`,
	);
	await ws.bb.interfaces.register({
		key: "acceptance",
		canonicalPath: "metadata.txt",
		version: 1,
		publishedBy: "before",
		lastModified: new Date().toISOString(),
		contentHash: hashText("metadata"),
		subscribers: [],
	});
	const goal = await ws.bb.goals.add(
		{ title: "accept artifact" },
		"in_progress",
	);
	await ws.bb.state.workspots.save(
		workspotSchema.parse({
			id: "ws",
			branch: "main",
			worktreePath: ws.projectDir,
			status: "active",
			primaryTask: goal.id,
		}),
	);
	await ws.bb.sessions.register("writer", "agent");
	let read = await captureReturnedInput(ws.projectDir, "api.txt", {
		returned: "v1",
		content: "v1",
		selector: { kind: "file" },
	});
	if (mode === "sampled") read = await hashPathClaim(ws.projectDir, "api.txt");
	if (mode === "unknown")
		read = {
			path: "api.txt",
			version: hashText("v1"),
			observation: {
				schemaVersion: 1,
				source: "unknown",
				reason: "返回内容无法归因",
			},
		};
	await ws.bb.sessions.recordActivity("writer", {
		activity: "read",
		agent: "writer",
		used: [read],
		generated: [],
	});
	const cp = checkpointSchema.parse({
		id: "cp",
		goal: goal.id,
		workspot: "ws",
		writerId: "writer",
		timestamp: new Date().toISOString(),
		lifecycle: "draft",
		assertion: "accept contract",
		artifact: {
			path: "consumer.txt",
			inputs: ["api.txt"],
			...(mode !== "legacy"
				? {
						inputRecords: [
							{ path: "api.txt", writerId: "writer", footprintSeq: 1 },
						],
					}
				: {}),
		},
		verification: {
			strategy: "test",
			command: `"${process.execPath}" check.cjs`,
			evidence: {
				report: {
					format: "vitest-json",
					path: "report.json",
					expectedTests: ["contract"],
				},
				inputs: ["check.cjs"],
			},
		},
		blackboardEffects: {
			publish: [],
			update: [{ key: "acceptance", field: "publishedBy", value: "after" }],
		},
	});
	cp.artifactInputOrigin = await selectArtifactInputs(ws.bb, cp);
	await ws.bb.checkpoints.save(cp, "staging");
	await ws.bb.goals.update(goal.id, { checkpoints: ["cp"] });
	await verifyCheckpoint(ws.bb, "cp", []);
	return { ...ws, goalId: goal.id };
}
