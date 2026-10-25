import { execFileSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureReturnedInput } from "../../../../src/blackboard/footprint-sample";
import { hashText } from "../../../../src/hash";
import { verifyCheckpoint } from "../../../../src/runtime/verify-checkpoint";
import {
	initGitFixture,
	makeTempWorkbench,
} from "../../../../src/test/fixtures";
import { checkpointSchema } from "../../../../src/types/checkpoint";
import { workspotSchema } from "../../../../src/types/workspot";

export const ARTIFACT_ID = "cost-artifact";
export const CHECKPOINT_ID = "cost-check";

export type CostFixture = Awaited<ReturnType<typeof makeTempWorkbench>> & {
	fileBytes: {
		footprint: number;
		events: number;
		input: number;
	};
};

/** Build one real Git/Node fixture with a synthetic footprint/event ledger prefix. */
export async function makeCostFixture(
	rows: number,
	verify = true,
): Promise<CostFixture> {
	const ws = await makeTempWorkbench();
	initGitFixture(ws.projectDir);
	const write = (name: string, text: string) =>
		writeFile(join(ws.projectDir, name), text);
	await write(".gitignore", ".workbench/\nreport.json\n");
	await write("api.txt", "v1");
	await write("consumer.txt", "v1");
	await write(
		"case.json",
		JSON.stringify({
			id: ARTIFACT_ID,
			input: "v1",
			artifact: "v1",
			toolCoverage: "full",
			repeatConsumes: 4,
		}),
	);
	await write(
		"check.cjs",
		await readFile(
			new URL("../../../../fixtures/artifact-use/check.cjs", import.meta.url),
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
	git("add", ".gitignore", "api.txt", "consumer.txt", "case.json", "check.cjs");
	git("commit", "-qm", "cost fixture");
	await ws.bb.sessions.register("writer", "agent");
	const footprintFile = join(ws.bb.paths.sessions, "writer", "footprint.jsonl");
	const noise = Array.from({ length: rows }, (_, i) => ({
		timestamp: "2026-10-01T00:00:00Z",
		activity: `noise-${i}`,
		agent: "writer",
		used: [
			{
				path: "noise.txt",
				version: hashText(`noise-${i % 32}`),
				span: { start: (i % 256) + 1, end: (i % 256) + 1 },
			},
		],
		generated: [],
		facets: { tool: "Read" },
	}));
	await writeFile(
		footprintFile,
		`${noise.map((line) => JSON.stringify(line)).join("\n")}\n`,
	);
	await writeFile(
		ws.bb.paths.eventsFile,
		`${noise
			.map((line, i) =>
				JSON.stringify({
					id: `noise-${i}`,
					eventSeq: i + 1,
					timestamp: line.timestamp,
					source: "sessions",
					type: "footprint",
					payload: { writer: "writer", ...line },
				}),
			)
			.join("\n")}\n`,
	);
	const observed = await captureReturnedInput(ws.projectDir, "api.txt", {
		returned: "v1",
		content: "v1",
		selector: { kind: "file" },
	});
	await ws.bb.sessions.recordActivity("writer", {
		activity: "read",
		agent: "writer",
		used: [observed],
		generated: [],
	});
	const goal = await ws.bb.goals.add({ title: ARTIFACT_ID }, "in_progress");
	await ws.bb.state.workspots.save(
		workspotSchema.parse({
			id: "cost-workspot",
			branch: "main",
			worktreePath: ws.projectDir,
			status: "active",
			primaryTask: goal.id,
		}),
	);
	const cp = checkpointSchema.parse({
		id: CHECKPOINT_ID,
		goal: goal.id,
		workspot: "cost-workspot",
		writerId: "writer",
		timestamp: new Date().toISOString(),
		lifecycle: "draft",
		assertion: "cost contract",
		artifact: {
			path: "consumer.txt",
			inputs: ["api.txt"],
			inputRecords: [
				{ path: "api.txt", writerId: "writer", footprintSeq: rows + 1 },
			],
			targetRef: "main",
		},
		verification: {
			strategy: "test",
			evidence: {
				report: {
					format: "vitest-json",
					path: "report.json",
					expectedTests: ["contract input", "contract consumer"],
				},
				inputs: ["check.cjs", "case.json"],
				fixedFiles: {
					mode: "node-offline-files-v1",
					script: "check.cjs",
					complete: true,
				},
			},
		},
	});
	await ws.bb.checkpoints.save(cp, "staging");
	await ws.bb.goals.update(goal.id, { checkpoints: [cp.id] });
	if (verify) await verifyCheckpoint(ws.bb, cp.id, []);
	return Object.assign(ws, {
		fileBytes: {
			footprint: (await stat(footprintFile)).size,
			events: (await stat(ws.bb.paths.eventsFile)).size,
			input: (await stat(join(ws.projectDir, "api.txt"))).size,
		},
	});
}
