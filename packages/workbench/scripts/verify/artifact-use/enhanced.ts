/** Current production observer. Expectations are consumed only by the frozen judge. */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { revalidateArtifact } from "../../../src/artifacts/revalidate";
import { listArtifactReviews } from "../../../src/artifacts/status";
import { checkArtifactUse } from "../../../src/artifacts/use-guard";
import {
	captureReturnedInput,
	hashPathClaim,
} from "../../../src/blackboard/footprint-sample";
import { acquireRunLock } from "../../../src/fs/lockfile";
import { verifyCheckpoint } from "../../../src/runtime/verify-checkpoint";
import { initGitFixture, makeTempWorkbench } from "../../../src/test/fixtures";
import { checkpointSchema } from "../../../src/types/checkpoint";
import { workspotSchema } from "../../../src/types/workspot";

export type EnhancedMode =
	| "enhanced"
	| "without-return-origin"
	| "without-fixed-copy"
	| "without-use-guard"
	| "without-target-range";
export interface ReplayCase {
	id: string;
	input: string;
	artifact: string;
	toolCoverage: string;
	beforeCapture?: string;
	beforeCheck?: string;
	after?: string;
	reread?: boolean;
	recheck?: boolean;
	targetAdvance?: string;
	repeatConsumes?: number;
}

export async function runEnhanced(
	spec: ReplayCase,
	mode: EnhancedMode = "enhanced",
) {
	const ws = await makeTempWorkbench();
	try {
		initGitFixture(ws.projectDir);
		const file = (name: string, text: string) =>
			writeFile(join(ws.projectDir, name), text);
		await file(".gitignore", ".workbench/\nreport.json\n");
		await file("api.txt", spec.input);
		const returned = await readFile(join(ws.projectDir, "api.txt"), "utf8");
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
				{ cwd: ws.projectDir, stdio: "pipe", timeout: 10_000 },
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
		if (spec.beforeCapture !== undefined)
			await file("api.txt", spec.beforeCapture);
		const observed =
			spec.toolCoverage === "full"
				? mode === "without-return-origin"
					? await hashPathClaim(ws.projectDir, "api.txt")
					: await captureReturnedInput(ws.projectDir, "api.txt", {
							returned,
							content: returned,
							selector: { kind: "file" },
						})
				: undefined;
		let capturedReads = 0;
		if (observed) {
			await ws.bb.sessions.recordActivity("writer", {
				activity: "read",
				agent: "writer",
				used: [observed],
				generated: [],
			});
			capturedReads++;
		}
		if (spec.beforeCheck !== undefined) await file("api.txt", spec.beforeCheck);
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
					...(observed && mode !== "without-return-origin"
						? {
								inputRecords: [
									{ path: "api.txt", writerId: "writer", footprintSeq: 1 },
								],
							}
						: {}),
					...(spec.targetAdvance ? { targetRef: "main" } : {}),
				},
				verification: {
					strategy: "test",
					...(mode === "without-fixed-copy"
						? { command: `"${process.execPath}" check.cjs` }
						: {}),
					evidence: {
						report: {
							format: "vitest-json",
							path: "report.json",
							expectedTests: ["contract input", "contract consumer"],
						},
						inputs: ["check.cjs", "case.json"],
						...(mode !== "without-fixed-copy"
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
			}),
			"staging",
		);
		await verifyCheckpoint(ws.bb, "cp", []);
		if (mode === "without-target-range") {
			for (const zone of ["verified", "staging", "failed"] as const) {
				const cp = (await ws.bb.checkpoints.scanZone(zone)).find(
					(cp) => cp.id === "cp",
				);
				if (cp?.artifactBinding?.target)
					await ws.bb.checkpoints.save(
						{
							...cp,
							artifactBinding: {
								...cp.artifactBinding,
								target: {
									...cp.artifactBinding.target,
									scope: undefined,
									blobs: undefined,
								},
							},
						},
						zone,
					);
			}
		}
		if (spec.after !== undefined) await file("api.txt", spec.after);
		if (spec.reread) {
			const current = await readFile(join(ws.projectDir, "api.txt"), "utf8");
			await ws.bb.sessions.recordActivity("writer", {
				activity: "reread",
				agent: "writer",
				generated: [],
				used: [
					mode === "without-return-origin"
						? await hashPathClaim(ws.projectDir, "api.txt")
						: await captureReturnedInput(ws.projectDir, "api.txt", {
								returned: current,
								content: current,
								selector: { kind: "file" },
							}),
				],
			});
			capturedReads++;
		}
		if (spec.targetAdvance !== undefined) {
			await file("api.txt", spec.targetAdvance);
			git("add", "api.txt");
			git("commit", "-qm", "target advances");
			await file("api.txt", spec.input);
		}
		if (spec.recheck) await revalidateArtifact(ws.bb, "cp");
		let consumable = false;
		let consumerQueries = 0;
		const root = Object.values(await ws.bb.checkpoints.scanAll())
			.flat()
			.find((cp) => cp.id === "cp")!;
		for (let i = 0; i < (spec.repeatConsumes ?? 1); i++) {
			consumerQueries++;
			if (mode === "without-use-guard")
				consumable =
					(await listArtifactReviews(ws.bb))[0]!.status === "current";
			else {
				const lock = await acquireRunLock(ws.bb.paths.root);
				if (!lock.acquired)
					throw new Error("controlled guard lock unavailable");
				try {
					consumable = (await checkArtifactUse(ws.bb, root)).ok;
				} finally {
					await lock.release();
				}
			}
		}
		const review = (await listArtifactReviews(ws.bb))[0]!;
		const checkpoints = Object.values(await ws.bb.checkpoints.scanAll()).flat();
		const latest = checkpoints.find((cp) => cp.id === review.checkpointId)!;
		const requests = (
			await ws.bb.events.query({ type: "request_verification" })
		).length;
		return {
			id: spec.id,
			consumable,
			originInput:
				mode !== "without-return-origin" &&
				review.inputOrigin?.reads[0]?.contentHash
					? review.inputOrigin.reads[0].contentHash
					: (review.origin?.files["api.txt"] ?? null),
			observedInput:
				observed?.observation?.source === "tool-observed"
					? observed.observation.contentHash
					: (observed?.version ?? null),
			targetChecked: review.targetStatus === "target-checked",
			executions: requests,
			repeatedChecks: requests,
			review: review.status,
			originStrength: review.facts?.origin.strength ?? "unknown",
			consumerQueries,
			capturedReads,
			copyBytes: latest.verificationResult?.object?.copyBytes ?? null,
			copyMs: latest.verificationResult?.object?.copyMs ?? null,
			runMs: latest.verificationResult?.object?.runMs ?? null,
			localResult: latest.verificationResult?.status ?? null,
			localExit: latest.verificationResult?.exitCode ?? null,
			modelTokens: null,
			modelCost: null,
		};
	} finally {
		await ws.cleanup();
	}
}
