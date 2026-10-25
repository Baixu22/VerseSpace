/** Production baseline observations; the independent oracle lives in judge.mjs. */

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source =
	process.env.MOAT_SOURCE_ROOT ??
	fileURLToPath(new URL("../../../../../", import.meta.url));
const load = (path: string) =>
	import(pathToFileURL(join(source, "packages/workbench/src", path)).href);
const { hashPathClaim } = await load("blackboard/footprint.ts");
const { listArtifactReviews } = await load("artifacts/status.ts");
const { revalidateArtifact } = await load("artifacts/revalidate.ts");
const { verifyCheckpoint } = await load("runtime/verify-checkpoint.ts");
const { initGitFixture, makeTempWorkbench } = await load("test/fixtures.ts");
const { checkpointSchema } = await load("types/checkpoint.ts");
const { workspotSchema } = await load("types/workspot.ts");

type Case = {
	id: string;
	input: string;
	artifact: string;
	beforeCapture?: string;
	beforeCheck?: string;
	after?: string;
	reread?: boolean;
	recheck?: boolean;
	targetAdvance?: string;
	toolCoverage: string;
	repeatConsumes?: number;
};

export async function runWorkbench(spec: Case) {
	const ws = await makeTempWorkbench();
	try {
		initGitFixture(ws.projectDir);
		const file = (name: string, text: string) =>
			writeFile(join(ws.projectDir, name), text);
		await file(".gitignore", ".workbench/\nreport.json\n");
		await file("api.txt", spec.input);
		await file("consumer.txt", spec.artifact);
		await file("case.json", JSON.stringify(spec));
		await file(
			"check.cjs",
			await readFile(
				new URL("../../../fixtures/artifact-use/check.cjs", import.meta.url),
				"utf8",
			),
		);
		const git = (...args: string[]) =>
			execFileSync(
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
				{ cwd: ws.projectDir, stdio: "pipe" },
			);
		git(
			"add",
			".gitignore",
			"api.txt",
			"consumer.txt",
			"case.json",
			"check.cjs",
		);
		git("commit", "-qm", "frozen case");
		await ws.bb.sessions.register("writer", "agent");
		// Capture after the modeled CLI has returned the original input bytes.
		if (spec.beforeCapture) await file("api.txt", spec.beforeCapture);
		const observed =
			spec.toolCoverage === "full"
				? await hashPathClaim(ws.projectDir, "api.txt")
				: undefined;
		if (observed)
			await ws.bb.sessions.recordActivity("writer", {
				activity: "read",
				agent: "writer",
				used: [observed],
				generated: [],
			});
		if (spec.beforeCheck) await file("api.txt", spec.beforeCheck);
		const goal = await ws.bb.goals.add({ title: spec.id }, "in_progress");
		await ws.bb.state.workspots.save(
			workspotSchema.parse({
				id: "ws",
				branch: "main",
				worktreePath: ws.projectDir,
				status: "active",
				primaryTask: goal.id,
			}),
		);
		await ws.bb.checkpoints.save(
			checkpointSchema.parse({
				id: "cp",
				goal: goal.id,
				workspot: "ws",
				writerId: "writer",
				timestamp: new Date().toISOString(),
				lifecycle: "draft",
				assertion: "controlled contract",
				artifact: {
					path: "consumer.txt",
					inputs: ["api.txt"],
					...(spec.targetAdvance ? { targetRef: "main" } : {}),
				},
				verification: {
					strategy: "test",
					command: `"${process.execPath}" check.cjs`,
					evidence: {
						report: {
							format: "vitest-json",
							path: "report.json",
							expectedTests: ["contract input", "contract consumer"],
						},
						inputs: ["check.cjs", "case.json"],
					},
				},
			}),
			"staging",
		);
		await verifyCheckpoint(ws.bb, "cp", []);
		if (spec.after) await file("api.txt", spec.after);
		if (spec.reread)
			await ws.bb.sessions.recordActivity("writer", {
				activity: "reread",
				agent: "writer",
				used: [await hashPathClaim(ws.projectDir, "api.txt")],
				generated: [],
			});
		if (spec.targetAdvance) {
			await file("api.txt", spec.targetAdvance);
			git("add", "api.txt");
			git("commit", "-qm", "target advances");
			await file("api.txt", spec.input);
		}
		if (spec.recheck) await revalidateArtifact(ws.bb, "cp");
		for (let i = 0; i < (spec.repeatConsumes ?? 1); i++)
			await listArtifactReviews(ws.bb);
		const review = (await listArtifactReviews(ws.bb))[0]!;
		const repeatedChecks = (
			await ws.bb.events.query({ type: "request_verification" })
		).length;
		return {
			id: spec.id,
			consumable: review.status === "current",
			originInput: review.origin?.files["api.txt"] ?? null,
			observedInput: observed?.version ?? null,
			targetChecked: false,
			executions: spec.recheck ? 2 : 1,
			repeatedChecks,
			review: review.status,
		};
	} finally {
		await ws.cleanup();
	}
}
