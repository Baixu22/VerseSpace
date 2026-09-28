/**
 * Optional real-Codex experiment. Requires an explicitly configured isolated
 * CODEX_HOME and WORKBENCH_CODEX_COMMAND; it is not part of ordinary bun test.
 * Run both --case own-fresh and --case own-stale with the same provider profile.
 * Exit 0 means an observation was made, never that write protection is proven.
 * Exit 2 means the provider or the read/stale precondition could not be measured.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatThreads, type RunEvent } from "../../src/chat/threads";
import { reconcilePremises } from "../../src/runtime/premises";
import { decideSeal } from "../../src/runtime/seal";
import { SEAL_EVENT } from "../../src/runtime/seal-counts";
import { makeTempWorkbench } from "../../src/test/fixtures";
import { probeCase, sealBaseline } from "./codex-seal-baseline";

const asJson = process.argv.includes("--json");
const verdict = {
	measured: false,
	reason: "",
	case: "",
	writerId: "",
	staleClaims: 0,
	writeLanded: false,
	contentBefore: "",
	contentAfter: "",
	sealEventsAfterCodex: 0,
	sealDecisions: [] as unknown[],
	controlDecision: "",
};
async function measure() {
	const scenario = probeCase(process.argv.slice(2));
	verdict.case = scenario;
	if (!process.env.WORKBENCH_CODEX_COMMAND || !process.env.CODEX_HOME)
		throw new Error("缺显式 WORKBENCH_CODEX_COMMAND 或隔离 CODEX_HOME");
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	let threadId: string | undefined;
	try {
		const target = "src/target.ts";
		const path = join(ws.projectDir, target);
		await mkdir(join(ws.projectDir, "src"), { recursive: true });
		await writeFile(path, "export const target = 1;\n");
		await ws.bb.config.save({ project: "", chat: { provider: "codex" } });
		const thread = await chat.create();
		threadId = thread.id;
		const readEvents: RunEvent[] = [];
		await chat.run(
			thread.id,
			// Force `cat` specifically: the codex footprint channel only parses
			// `cat <path>` (Get-Content / type stay outside the compatibility
			// boundary — see codex-footprint.test.ts). Under danger-full-access
			// the model prefers Get-Content/type, the read footprint vanishes and
			// sealBaseline cannot measure. Measured 2026-09-27.
			"Run exactly this shell command and report the output: cat src/target.ts",
			(e) => {
				readEvents.push(e);
			},
		);
		if (readEvents.some((e) => e.type === "error"))
			throw new Error("真实读取回合失败");
		if (scenario === "own-stale") {
			// Change the export surface as well as the content, avoiding the documented
			// dependency-body suppression heuristic as a confounder in this experiment.
			await writeFile(path, "export const changedTarget = 2;\n");
		}
		await reconcilePremises(ws.bb);
		const baseline = await sealBaseline(
			ws.bb,
			thread.id,
			target,
			scenario === "own-stale",
		);
		verdict.writerId = baseline.writerId;
		verdict.staleClaims = baseline.claims.length;
		verdict.contentBefore = await readFile(path, "utf8");
		const beforeEvents = (await ws.bb.events.query({ type: SEAL_EVENT }))
			.length;
		const writeEvents: RunEvent[] = [];
		await chat.run(
			thread.id,
			"Run exactly this shell command and report what happened: echo '// written by codex' >> src/target.ts",
			(e) => {
				writeEvents.push(e);
			},
		);
		if (writeEvents.some((e) => e.type === "error"))
			throw new Error("真实写入回合失败");
		verdict.contentAfter = await readFile(path, "utf8");
		verdict.writeLanded = verdict.contentAfter !== verdict.contentBefore;
		const events = (await ws.bb.events.query({ type: SEAL_EVENT })).slice(
			beforeEvents,
		);
		verdict.sealEventsAfterCodex = events.length;
		verdict.sealDecisions = events.map((e) => e.payload);
		// Frozen pre-write baseline: same writer and claims, even if the model reread
		// the file during its write turn. This control is excluded from lane counts.
		verdict.controlDecision = (await decideSeal(ws.bb, baseline)).decision;
		verdict.measured = true;
	} finally {
		if (threadId) chat.cancel(threadId);
		await ws.cleanup();
	}
}
try {
	await measure();
} catch (error) {
	verdict.measured = false;
	verdict.reason = error instanceof Error ? error.message : String(error);
}
console.log(asJson ? JSON.stringify(verdict, null, 2) : verdict);
process.exitCode = verdict.measured ? 0 : 2;
