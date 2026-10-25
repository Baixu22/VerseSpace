import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { listArtifactReviews } from "../../src/artifacts/status";
import { openBlackboard } from "../../src/blackboard";
import {
	captureReturnedInput,
	hashPathClaim,
} from "../../src/blackboard/footprint-sample";
import { verifyCheckpoint } from "../../src/runtime/verify-checkpoint";
import { checkpointSchema } from "../../src/types/checkpoint";
import { workspotSchema } from "../../src/types/workspot";

const arg = (name: string) => {
	const index = process.argv.indexOf(name);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value) throw new Error(`missing ${name}`);
	return value;
};
const workspace = resolve(arg("--workspace"));
const threadIds = {
	current: arg("--current"),
	stale: arg("--stale"),
	unknown: arg("--unknown"),
} as const;
const modes = Object.keys(threadIds) as Array<keyof typeof threadIds>;
const git = (args: string[]) =>
	execFileSync(
		"git",
		[
			"-c",
			"core.hooksPath=",
			"-c",
			"user.name=e2e",
			"-c",
			"user.email=e2e@example.invalid",
			...args,
		],
		{ cwd: workspace, stdio: "pipe", timeout: 15_000 },
	);
if (!existsSync(join(workspace, ".git"))) git(["init", "-q", "-b", "main"]);
await writeFile(
	join(workspace, ".gitignore"),
	".workbench/\nreport-e2e-*.json\n",
);
for (const mode of modes) {
	await writeFile(join(workspace, `api-${mode}.txt`), "v1");
	await writeFile(join(workspace, `consumer-${mode}.txt`), "v1");
	await writeFile(
		join(workspace, `case-${mode}.json`),
		JSON.stringify({ mode, input: "api", artifact: "consumer" }),
	);
	await writeFile(
		join(workspace, `check-${mode}.cjs`),
		`const fs=require("node:fs");const api=fs.readFileSync("api-${mode}.txt","utf8");const consumer=fs.readFileSync("consumer-${mode}.txt","utf8");const ok=api===consumer;const names=["artifact input","artifact consumer"];const tests=names.map((fullName)=>({fullName,status:ok?"passed":"failed"}));fs.writeFileSync("report-e2e-${mode}.json",JSON.stringify({numTotalTests:tests.length,numPassedTests:ok?tests.length:0,numFailedTests:ok?0:tests.length,numPendingTests:0,success:ok,testResults:[{assertionResults:tests}]}));process.exitCode=ok?0:1;`,
	);
}
git(["add", ".gitignore"]);
for (const mode of modes)
	git([
		"add",
		`api-${mode}.txt`,
		`consumer-${mode}.txt`,
		`case-${mode}.json`,
		`check-${mode}.cjs`,
	]);
git(["commit", "-qm", "e2e artifact review fixtures"]);

const bb = openBlackboard(join(workspace, ".workbench"));
for (const mode of modes) {
	const writerId = `e2e-writer-${mode}`;
	const apiPath = `api-${mode}.txt`;
	const consumerPath = `consumer-${mode}.txt`;
	const checkPath = `check-${mode}.cjs`;
	const casePath = `case-${mode}.json`;
	const reportPath = `report-e2e-${mode}.json`;
	await bb.sessions.register(writerId, "agent");
	const observed =
		mode === "unknown"
			? await hashPathClaim(workspace, apiPath)
			: await captureReturnedInput(workspace, apiPath, {
					returned: "v1",
					content: "v1",
					selector: { kind: "file" },
				});
	await bb.sessions.recordActivity(writerId, {
		activity: "read",
		agent: writerId,
		used: [observed],
		generated: [],
	});
	const goal = await bb.goals.add(
		{ title: `e2e artifact ${mode}` },
		"in_progress",
	);
	await bb.state.workspots.save(
		workspotSchema.parse({
			id: `e2e-artifact-${mode}`,
			branch: "main",
			worktreePath: workspace,
			status: "active",
			primaryTask: goal.id,
		}),
	);
	const checkpoint = checkpointSchema.parse({
		id: `e2e-artifact-${mode}`,
		goal: goal.id,
		workspot: `e2e-artifact-${mode}`,
		writerId,
		threadId: threadIds[mode],
		timestamp: new Date().toISOString(),
		lifecycle: "draft",
		assertion: `artifact ${mode}`,
		artifact: {
			path: consumerPath,
			inputs: [apiPath],
			inputRecords: [{ path: apiPath, writerId, footprintSeq: 1 }],
			targetRef: "main",
		},
		verification: {
			strategy: "test",
			evidence: {
				report: {
					format: "vitest-json",
					path: reportPath,
					expectedTests: ["artifact input", "artifact consumer"],
				},
				inputs: [checkPath, casePath],
				fixedFiles: {
					mode: "node-offline-files-v1",
					script: checkPath,
					complete: true,
				},
			},
		},
	});
	await bb.checkpoints.save(checkpoint, "staging");
	await bb.goals.update(goal.id, { checkpoints: [checkpoint.id] });
	await verifyCheckpoint(bb, checkpoint.id, []);
	if (mode === "stale") await writeFile(join(workspace, apiPath), "v2");
}
const reviews = (await listArtifactReviews(bb)).filter((review) =>
	Object.values(threadIds).includes(review.threadId ?? ""),
);
for (const mode of modes) {
	const review = reviews.find((row) => row.threadId === threadIds[mode]);
	if (review?.status !== mode)
		throw new Error(`expected ${mode}, got ${review?.status ?? "missing"}`);
}
console.log(
	JSON.stringify({
		workspace,
		reviews: reviews.map((review) => ({
			rootId: review.rootId,
			threadId: review.threadId,
			status: review.status,
			targetStatus: review.targetStatus,
			origin: review.facts?.origin.strength,
		})),
	}),
);
