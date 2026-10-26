/** Optional TF-0264 live probe. Requires the isolated RPC tap used by the handoff. */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatThreads, type RunEvent } from "../../src/chat/threads";
import { makeTempWorkbench } from "../../src/test/fixtures";

interface TraceRow {
	direction: string;
	value: Record<string, unknown>;
}

async function traceRows(dir: string): Promise<TraceRow[]> {
	const rows: TraceRow[] = [];
	for (const file of (await readdir(dir))
		.filter((f) => f.startsWith("rpc-"))
		.sort()) {
		for (const line of (await readFile(join(dir, file), "utf8")).split("\n")) {
			if (!line) continue;
			rows.push(JSON.parse(line) as TraceRow);
		}
	}
	return rows;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function livePid(dir: string): Promise<number> {
	const pid = (await traceRows(dir))
		.filter((r) => r.direction === "process" && r.value.event === "spawn")
		.at(-1)?.value.pid;
	if (typeof pid !== "number" || !alive(pid))
		throw new Error("No live tapped Codex process");
	return pid;
}

async function waitForTurn(dir: string, after: number): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		if (
			(await traceRows(dir))
				.slice(after)
				.some(
					(r) => r.direction === "server" && r.value.method === "turn/started",
				)
		)
			return;
		await Bun.sleep(25);
	}
	throw new Error("No real turn/started before intervention");
}

async function measure() {
	const trace = process.env.WB_VERIFY_TRACE_DIR;
	if (!trace || !process.env.CODEX_HOME || !process.env.WORKBENCH_CODEX_COMMAND)
		throw new Error(
			"Explicit isolated profile, tapped command and trace directory required",
		);
	await mkdir(trace, { recursive: true });
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	const turns: Record<string, RunEvent[]> = {};
	const report: Record<string, unknown> = {};
	let attributedReadTurns = 0;
	let threadId = "";
	let active: Promise<void> | undefined;
	const timeout = setTimeout(() => chat.cancel(threadId), 180_000);
	try {
		await mkdir(join(ws.projectDir, "src"));
		await writeFile(
			join(ws.projectDir, "src/target.ts"),
			"export const target = 1;\n",
		);
		await ws.bb.config.save({ project: "", chat: { provider: "codex" } });
		threadId = (await chat.create("TF-0264 live lifecycle")).id;
		const run = (name: string, text: string) => {
			const events: RunEvent[] = [];
			turns[name] = events;
			active = chat.run(threadId, text, (event) => events.push(event));
			return active;
		};
		const read =
			"Run exactly this shell command and report the output: cat src/target.ts";
		await run("normal", read);
		if (turns.normal!.some((e) => e.type === "error"))
			throw new Error("Live read failed");
		const originalSession = (await chat.get(threadId)).codexSessionId;
		const normalPid = await livePid(trace);
		const normalReads = (await ws.bb.sessions.footprint(threadId)).filter((f) =>
			f.used.some((c) => c.path === "src/target.ts"),
		).length;
		if (normalReads === 0)
			throw new Error("Normal read lacks an attributed footprint");
		attributedReadTurns += 1;
		report.normal = {
			pid: normalPid,
			finalThreadState: (await chat.get(threadId)).status,
			readFootprints: normalReads,
		};

		for (const intervention of ["failure", "cancel"] as const) {
			const pid = await livePid(trace);
			const after = (await traceRows(trace)).length;
			const pending = run(
				intervention,
				'Run exactly this command: powershell.exe -NoProfile -Command "Start-Sleep -Seconds 30"; then report completion.',
			);
			await waitForTurn(trace, after);
			if (intervention === "failure") process.kill(pid);
			else chat.cancel(threadId);
			await pending;
			const deadline = Date.now() + 5_000;
			while (alive(pid) && Date.now() < deadline) await Bun.sleep(25);
			const errors = turns[intervention]!.filter((e) => e.type === "error");
			const finalThreadState = (await chat.get(threadId)).status;
			report[intervention] = {
				pid,
				processExited: !alive(pid),
				errors: errors.length,
				finalThreadState,
			};
			if (alive(pid) || errors.length === 0 || finalThreadState !== "idle")
				throw new Error(
					`${intervention} did not settle a real process and thread`,
				);
			const beforeRead = (await ws.bb.sessions.footprint(threadId)).length;
			await run(`restart-${intervention}`, read);
			const readFootprints = (await ws.bb.sessions.footprint(threadId))
				.slice(beforeRead)
				.filter((f) => f.used.some((c) => c.path === "src/target.ts")).length;
			if (readFootprints === 0)
				throw new Error(
					`${intervention} resumed read lacks an attributed footprint`,
				);
			attributedReadTurns += 1;
			const nextPid = await livePid(trace);
			const resumed = await chat.get(threadId);
			const successful = !turns[`restart-${intervention}`]!.some(
				(e) => e.type === "error",
			);
			report[`restart-${intervention}`] = {
				pid: nextPid,
				changedProcess: nextPid !== pid,
				sameSession: resumed.codexSessionId === originalSession,
				finalThreadState: resumed.status,
				successful,
				readFootprints,
			};
			if (
				nextPid === pid ||
				!successful ||
				resumed.status !== "idle" ||
				resumed.codexSessionId !== originalSession
			)
				throw new Error(`${intervention} restart/resume failed`);
		}
		const footprints = await ws.bb.sessions.footprint(threadId);
		const reads = footprints.filter((f) =>
			f.used.some((c) => c.path === "src/target.ts"),
		).length;
		if (reads < 3)
			throw new Error("Normal and resumed reads lack attributed footprints");
		return {
			measured: true,
			passed: 5,
			total: 5,
			reads,
			attributedReadTurns,
			cases: report,
			cancelMechanism:
				"Workbench.cancel -> supervised process tree termination",
		};
	} finally {
		clearTimeout(timeout);
		chat.cancel(threadId);
		await active?.catch(() => {});
		await writeFile(
			join(trace, "lifecycle.json"),
			JSON.stringify(
				{
					thread: await chat.get(threadId).catch(() => null),
					turns,
					report,
					footprints: await ws.bb.sessions.footprint(threadId),
					ledgerEvents: await ws.bb.events.all(),
				},
				null,
				2,
			),
		);
		await ws.cleanup();
	}
}

try {
	console.log(JSON.stringify(await measure(), null, 2));
} catch (error) {
	console.log(
		JSON.stringify(
			{
				measured: false,
				passed: 0,
				total: 5,
				reason: error instanceof Error ? error.message : String(error),
			},
			null,
			2,
		),
	);
	process.exitCode = 2;
}
