import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../../packages/workbench/src/blackboard/footprint";
import { writerSpoolDir } from "../../packages/workbench/src/blackboard/sessions";
import { runOnce } from "../../packages/workbench/src/runtime";
import {
	drainPremiseQueue,
	pendingPremiseNotices,
} from "../../packages/workbench/src/runtime/delivery";
import { judgeWindow } from "../../packages/workbench/src/runtime/notice-window";
import { diffFor } from "../../packages/workbench/src/runtime/premise-diff";
import { reconcilePremises } from "../../packages/workbench/src/runtime/premises";
import { judgeSeal } from "../../packages/workbench/src/runtime/seal";
import { makeTempWorkbench } from "../../packages/workbench/src/test/fixtures";
import { checkpointSchema } from "../../packages/workbench/src/types/checkpoint";
import { workspotSchema } from "../../packages/workbench/src/types/workspot";
import { runVerification } from "../../packages/workbench/src/verifier";

const readings: Array<Record<string, unknown>> = [];

async function spans() {
	const ws = await makeTempWorkbench();
	try {
		await mkdir(join(ws.projectDir, "src"));
		const path = "src/ranges.ts";
		const lines = Array.from(
			{ length: 12 },
			(_, i) => `const line${i + 1} = ${i + 1};`,
		);
		await writeFile(join(ws.projectDir, path), `${lines.join("\n")}\n`);
		for (const writer of ["multi", "control"]) {
			await ws.bb.sessions.register(writer, "agent", writer);
			await ws.bb.sessions.recordActivity(writer, {
				activity: "read-first",
				agent: writer,
				used: [
					await hashPathClaim(
						ws.projectDir,
						path,
						writerSpoolDir(ws.bb.paths, writer),
						{ start: 1, end: 2 },
					),
				],
				generated: [],
				facets: { tool: "Read" },
			});
		}
		await ws.bb.sessions.recordActivity("multi", {
			activity: "read-later",
			agent: "multi",
			used: [
				await hashPathClaim(
					ws.projectDir,
					path,
					writerSpoolDir(ws.bb.paths, "multi"),
					{ start: 9, end: 10 },
				),
			],
			generated: [],
			facets: { tool: "Read" },
		});
		lines[0] = "const line1 = 999;";
		await writeFile(join(ws.projectDir, path), `${lines.join("\n")}\n`);
		const folded = (await ws.bb.sessions.readSetView("multi")).reads.get(path)!;
		const diff = await diffFor(ws.bb, "multi", folded);
		if (!diff)
			throw new Error("cannot measure span filtering: git diff unavailable");
		const notices = await reconcilePremises(ws.bb);
		const result = {
			case: "two-disjoint-reads-first-region-changes",
			retainedSpan: folded.span,
			multiReadNotices: notices.filter((n) => n.writerId === "multi").length,
			firstReadControlNotices: notices.filter((n) => n.writerId === "control")
				.length,
			diffAvailable: true,
		};
		assert.equal(result.multiReadNotices, 0);
		assert.equal(result.firstReadControlNotices, 1);
		readings.push(result);
	} finally {
		await ws.cleanup();
	}
}

async function deliveryVsRevalidation() {
	const ws = await makeTempWorkbench();
	try {
		const path = "api.txt";
		await writeFile(join(ws.projectDir, path), "old API\n");
		for (const writer of [
			"delivered-without-reread",
			"reread-without-delivery",
		]) {
			await ws.bb.sessions.register(writer, "agent", writer);
			await ws.bb.sessions.recordActivity(writer, {
				activity: "initial-read",
				agent: writer,
				used: [await hashPathClaim(ws.projectDir, path)],
				generated: [],
				facets: { tool: "Read" },
			});
		}
		await writeFile(join(ws.projectDir, path), "new API\n");
		assert.equal((await reconcilePremises(ws.bb)).length, 2);
		const current = await hashPathClaim(ws.projectDir, path);
		const rereadWriter = "reread-without-delivery";
		await ws.bb.sessions.recordActivity(rereadWriter, {
			activity: "fresh-reread",
			agent: rereadWriter,
			used: [current],
			generated: [],
			facets: { tool: "Read" },
		});
		const pendingBefore = await pendingPremiseNotices(ws.bb);
		const blockedAfterReread = judgeSeal(
			ws.projectDir,
			path,
			pendingBefore
				.filter((n) => n.writerId === rereadWriter)
				.flatMap((n) => n.claims),
		).blocked;
		const deliveredWriter = "delivered-without-reread";
		await drainPremiseQueue(ws.bb, {
			deliver: async (writer) => writer === deliveredWriter,
		});
		const pendingAfter = await pendingPremiseNotices(ws.bb);
		const staleRead = (
			await ws.bb.sessions.readSetView(deliveredWriter)
		).reads.get(path)!;
		const result = {
			case: "delivery-state-is-not-validity-state",
			rereadCurrentVersionStillBlockedBeforeDelivery: blockedAfterReread,
			deliveredWriterReadStillOld: staleRead.version !== current.version,
			deliveredWriterPendingNotices: pendingAfter.filter(
				(n) => n.writerId === deliveredWriter,
			).length,
			deliveredWriterBlocked: judgeSeal(
				ws.projectDir,
				path,
				pendingAfter
					.filter((n) => n.writerId === deliveredWriter)
					.flatMap((n) => n.claims),
			).blocked,
			newNoticesOnNextReconcile: (await reconcilePremises(ws.bb)).length,
		};
		assert.equal(result.rereadCurrentVersionStillBlockedBeforeDelivery, true);
		assert.equal(result.deliveredWriterReadStillOld, true);
		assert.equal(result.deliveredWriterPendingNotices, 0);
		assert.equal(result.deliveredWriterBlocked, false);
		readings.push(result);
	} finally {
		await ws.cleanup();
	}
}

async function checkpointFreshness() {
	const ws = await makeTempWorkbench();
	try {
		await writeFile(join(ws.projectDir, "answer.txt"), "correct");
		await writeFile(
			join(ws.projectDir, "check.cjs"),
			'const fs = require("node:fs"); if (fs.readFileSync("answer.txt", "utf8") !== "correct") { console.error("answer regressed"); process.exit(1); } console.log("one assertion passed");\n',
		);
		const verification = {
			strategy: "test" as const,
			command: `"${process.execPath}" check.cjs`,
		};
		const goal = await ws.bb.goals.add(
			{ title: "answer remains correct" },
			"in_progress",
		);
		await ws.bb.state.workspots.save(
			workspotSchema.parse({
				id: "probe",
				branch: "probe",
				worktreePath: ws.projectDir,
				primaryTask: goal.id,
				status: "active",
			}),
		);
		await ws.bb.checkpoints.save(
			checkpointSchema.parse({
				id: "cp-probe",
				goal: goal.id,
				workspot: "probe",
				timestamp: new Date().toISOString(),
				lifecycle: "draft",
				assertion: "answer remains correct",
				verification,
			}),
			"staging",
		);
		const first = await runOnce(ws.bb);
		assert.equal(first.verifications[0]?.result.status, "passed");
		await writeFile(join(ws.projectDir, "answer.txt"), "regression");
		const second = await runOnce(ws.bb);
		const third = await runOnce(ws.bb);
		const cp = (await ws.bb.checkpoints.scanZone("verified")).find(
			(c) => c.id === "cp-probe",
		)!;
		const now = await runVerification(verification, ws.projectDir);
		const result = {
			case: "file-changes-after-verification-before-done",
			firstVerification: first.verifications[0]?.result.status,
			checkpointAfterEdit: cp.lifecycle,
			archivedVerificationAfterEdit: cp.verificationResult?.status,
			goalAfterEdit: (await ws.bb.goals.get(goal.id))?.status,
			actualFreshRerun: now.status,
			runOnceReverifiedAfterEdit:
				second.verifications.length + third.verifications.length > 0,
		};
		assert.equal(result.goalAfterEdit, "done");
		assert.equal(result.actualFreshRerun, "failed");
		readings.push(result);
	} finally {
		await ws.cleanup();
	}
}

await spans();
await deliveryVsRevalidation();
readings.push({
	case: "repair-label-with-reread-only-and-no-verification",
	...judgeWindow(
		[
			{
				id: "fp-probe",
				eventSeq: 1,
				timestamp: new Date().toISOString(),
				source: "sessions",
				type: "footprint",
				payload: {
					writer: "writer",
					used: [{ path: "api.txt", version: "still-old" }],
					generated: [],
				},
			},
		],
		"writer",
		["api.txt"],
		"footprint",
	),
	verificationRuns: 0,
});
readings.push({
	case: "cross-file-write-after-stale-dependency",
	...judgeSeal("D:/isolated", "consumer.ts", [
		{ path: "api.ts", observedVersion: "v1", currentVersion: "v2" },
	]),
});
await checkpointFreshness();
console.log(
	JSON.stringify(
		{
			platform: process.platform,
			bun: Bun.version,
			classification:
				"isolated deterministic observations, not live-model or product acceptance",
			readings,
		},
		null,
		2,
	),
);
