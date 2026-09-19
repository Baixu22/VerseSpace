import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { makeTempWorkbench, type TempWorkbench } from "../test/fixtures";
import { createUiServer } from "../ui/server";
import { collectRestoreView } from "./restore-view";
import type { ResumeCardView } from "./resume-card";
import { branchResumeFacts } from "./resume-card/branches";
import { ChatThreads } from "./threads";

async function sourceThread(ws: TempWorkbench, chat: ChatThreads) {
	const source = await chat.create("恢复工作");
	await mkdir(join(ws.projectDir, "src"));
	await writeFile(join(ws.projectDir, "src/a.ts"), "export const a = 1;\n");
	await writeFile(
		join(ws.workbenchRoot, "threads", source.id, "messages.jsonl"),
		`${JSON.stringify({ id: "m-1", role: "user", text: "继续实现", at: new Date().toISOString() })}\n`,
	);
	return source;
}

async function readA(ws: TempWorkbench, writer: string) {
	await ws.bb.sessions.recordActivity(writer, {
		activity: "read-a",
		agent: writer,
		used: [await hashPathClaim(ws.projectDir, "src/a.ts")],
		generated: [],
	});
}

async function writeA(ws: TempWorkbench, writer: string, value: number) {
	await writeFile(
		join(ws.projectDir, "src/a.ts"),
		`export const a = ${value};\n`,
	);
	await ws.bb.sessions.recordActivity(writer, {
		activity: "write-a",
		agent: writer,
		used: [],
		generated: [await hashPathClaim(ws.projectDir, "src/a.ts")],
	});
}

test("R10: the GET route joins branch writes, ledger changes and evidence; dismiss survives the next GET", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	const server = await createUiServer(ws.bb, 0);
	try {
		const source = await sourceThread(ws, chat);
		const branch = (await chat.fork(source.id, "m-1")).thread!;
		const empty = (await chat.fork(source.id, "m-1")).thread!;
		const old = (await chat.fork(source.id, "m-1")).thread!;
		await writeA(ws, old.id, 2);
		await readA(ws, source.id);
		await chat.leave(source.id);
		const path = `/api/chat/threads/${source.id}`;
		const request = (suffix = "", method = "GET") =>
			server.handle(
				new Request(`http://127.0.0.1:${server.port}${path}${suffix}`, {
					method,
					headers: { "x-workbench-token": server.authToken },
				}),
			);
		const before = (await request().then((response) => response.json())) as {
			resumeCard: ResumeCardView;
		};
		expect(
			before.resumeCard.facts.filter((row) => row.source === "branch"),
		).toEqual([]);

		await writeA(ws, branch.id, 3);
		await chat.fork(branch.id, "m-1");
		const staleEvent = await ws.bb.events.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type: "premise_stale",
			payload: { writer: source.id, stale: [{ path: "src/a.ts" }] },
		});
		const events = await ws.bb.events.all();
		const restored = (await request().then((response) => response.json())) as {
			resumeCard: ResumeCardView;
		};
		const rows = restored.resumeCard.facts.filter(
			(row) => row.source === "branch",
		);
		expect(rows).toHaveLength(1);
		const row = rows[0]!;
		expect(row.annotation?.rule).toBe("R10");
		expect(row.branch).toEqual({
			threadId: branch.id,
			anchorMessageId: "m-1",
			paths: ["src/a.ts"],
			newForks: 1,
		});
		expect(row.refs).toContain(staleEvent.id!);
		const eventIds = new Set(events.map((event) => event.id));
		expect(
			row.refs.every((ref) => eventIds.has(ref.replace(/^footprint:/, ""))),
		).toBe(true);
		expect(row.refs).not.toHaveLength(0);
		expect(JSON.stringify(rows)).not.toContain(empty.id);
		expect(JSON.stringify(rows)).not.toContain(old.id);
		expect(row).not.toHaveProperty("status");
		expect(row).not.toHaveProperty("verdict");
		expect(restored.resumeCard.coverage.text).toContain("1 个已变");
		expect(await ws.bb.events.all()).toEqual(events);

		expect((await request("/resume-note/dismiss", "POST")).ok).toBe(true);
		const dismissed = (await request().then((response) => response.json())) as {
			resumeCard: ResumeCardView;
		};
		expect(
			dismissed.resumeCard.facts.some((fact) => fact.source === "branch"),
		).toBe(true);
		expect(dismissed.resumeCard.dismissed).toBe(true);
		expect(dismissed.resumeCard.inject).toBe(false);
	} finally {
		server.stop(true);
		await ws.cleanup();
	}
});

test("R10: siblings share the source lineage; unrelated writes, missing baselines and unreferenced lineage stay silent", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	try {
		const source = await sourceThread(ws, chat);
		const left = (await chat.fork(source.id, "m-1")).thread!;
		const right = (await chat.fork(source.id, "m-1")).thread!;
		const unrelated = await chat.create("其他工作");
		await readA(ws, left.id);
		await chat.leave(left.id);
		await writeA(ws, unrelated.id, 2);
		let view = await collectRestoreView(ws.bb, chat, left.id);
		expect(
			view.resumeCard?.facts.filter((row) => row.source === "branch"),
		).toEqual([]);
		await writeA(ws, right.id, 3);
		view = await collectRestoreView(ws.bb, chat, left.id);
		expect(
			view.resumeCard?.facts.find((row) => row.source === "branch")?.branch
				?.threadId,
		).toBe(right.id);
		const input = {
			bb: ws.bb,
			threadId: left.id,
			threads: await chat.list(),
			events: await ws.bb.events.all(),
			diff: view.readSetDiff,
		};
		expect(
			await branchResumeFacts({
				...input,
				diff: { ...input.diff, baseline: null },
			}),
		).toEqual([]);
		expect(
			await branchResumeFacts({
				...input,
				diff: { ...input.diff, stale: [] },
			}),
		).toEqual([]);
		expect(
			await branchResumeFacts({
				...input,
				events: input.events.filter((event) => event.type !== "thread.forked"),
			}),
		).toEqual([]);
	} finally {
		await ws.cleanup();
	}
});
