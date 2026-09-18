import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chatContext } from "../test/chat-context";
import { makeTempWorkbench } from "../test/fixtures";
import { resolveThreadEvidence } from "./evidence";
import { buildResumeNote } from "./resume";
import { ChatThreads, type RunEvent, type StoredPart } from "./threads";
import { flattenToolParts } from "./tool-collapse";

async function replay(events: Record<string, unknown>[]) {
	const ws = await makeTempWorkbench();
	const previous = process.env.WORKBENCH_CHAT_COMMAND;
	const chat = new ChatThreads(ws.bb);
	const script = join(ws.projectDir, "render-actor.mjs");
	await writeFile(join(ws.projectDir, "first.txt"), "first\n");
	await writeFile(join(ws.projectDir, "second.txt"), "second\n");
	await writeFile(
		script,
		`import { createInterface } from "node:readline";
for await (const line of createInterface({input: process.stdin})) {
  if (!line.trim()) continue;
  for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event));
  break;
}
process.exit(0);
`,
	);
	process.env.WORKBENCH_CHAT_COMMAND = `"${process.execPath}" "${script}"`;
	const thread = await chat.create();
	const emitted: RunEvent[] = [];
	try {
		await chat.run(thread.id, "检查两个文件", (event) => {
			emitted.push(structuredClone(event));
		});
	} catch (error) {
		chat.cancel(thread.id);
		await ws.cleanup();
		throw error;
	} finally {
		if (previous === undefined) delete process.env.WORKBENCH_CHAT_COMMAND;
		else process.env.WORKBENCH_CHAT_COMMAND = previous;
	}
	return {
		ws,
		chat,
		thread,
		emitted,
		async cleanup() {
			const session = chatContext(chat).live.get(thread.id);
			chat.cancel(thread.id);
			await session?.closed;
			await ws.cleanup();
		},
	};
}

const delta = (text: string) => ({
	type: "stream_event",
	event: { type: "content_block_delta", delta: { type: "text_delta", text } },
});
const frame = (id: string, content: Record<string, unknown>[]) => ({
	type: "assistant",
	message: { id, content },
});
const tools = [
	{
		type: "tool_use",
		id: "r1",
		name: "Read",
		input: { file_path: "first.txt" },
	},
	{
		type: "tool_use",
		id: "r2",
		name: "Read",
		input: { file_path: "second.txt" },
	},
];
const init = { type: "system", subtype: "init", session_id: "render-session" };
const success = { type: "result", subtype: "success", result: "检查完成" };

function applyVisible(parts: StoredPart[], event: RunEvent): StoredPart[] {
	if (event.type === "parts") return structuredClone(event.parts);
	if (event.type !== "delta") return parts;
	const last = parts.at(-1);
	if (last?.type === "text") last.text += event.text;
	else parts.push({ type: "text", text: event.text });
	return parts;
}

describe("Claude collapsed transcript integration", () => {
	test("live parts, done and disk agree; nested tools retain footprints and resume evidence", async () => {
		const run = await replay([
			init,
			delta("开始检查。"),
			frame("intro", [{ type: "text", text: "开始检查。" }]),
			frame("reads", tools),
			frame("reads", tools),
			{
				type: "user",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "r1", content: "first\n" },
						{ type: "tool_result", tool_use_id: "r2", content: "second\n" },
					],
				},
			},
			delta("检查"),
			delta("完成。"),
			frame("tail", [{ type: "text", text: "检查完成。" }]),
			success,
		]);
		try {
			const { emitted, chat, thread, ws } = run;
			const done = emitted.find((event) => event.type === "done");
			expect(done).toBeDefined();
			if (!done) throw new Error("missing authoritative done");
			const visible = emitted.reduce(applyVisible, [] as StoredPart[]);
			expect(done.message.parts).toEqual(visible);
			expect(done.message.text).toBe("开始检查。检查完成。");
			expect(visible.map((part) => part.type)).toEqual([
				"text",
				"collapsed-group",
				"text",
			]);
			const snapshots = emitted.filter((event) => event.type === "parts");
			expect(
				snapshots.some((event) =>
					event.parts.some(
						(part) => part.type === "collapsed-group" && part.active,
					),
				),
			).toBe(true);
			expect(visible[1]).toMatchObject({
				type: "collapsed-group",
				id: "group:r1",
				active: false,
				summary: "读取 2 个文件",
			});
			expect(flattenToolParts(visible).map((tool) => tool.result)).toEqual([
				"first\n",
				"second\n",
			]);
			for (const event of emitted) {
				if (event.type !== "user")
					expect(event.messageId).toBe(done.message.id);
			}
			const messages = await chat.messages(thread.id);
			expect(messages.at(-1)).toEqual(done.message);
			const disk = await readFile(
				join(ws.workbenchRoot, "threads", thread.id, "messages.jsonl"),
				"utf8",
			);
			expect(JSON.parse(disk.trim().split(/\r?\n/).at(-1)!)).toEqual(
				done.message,
			);
			expect(
				(await ws.bb.sessions.footprint(thread.id)).map(
					(item) => item.activity,
				),
			).toEqual(["r1", "r2"]);
			const note = buildResumeNote(messages, {});
			const shifted = note?.beats.find((beat) => beat.kind === "shifted");
			expect(shifted?.text).toContain("动了 2 处");
			expect(shifted?.refs).toEqual([
				`message:${done.message.id}`,
				"tool:r1",
				"path:first.txt",
				"tool:r2",
				"path:second.txt",
			]);
			for (const id of ["r1", "r2"]) {
				const evidence = await resolveThreadEvidence(
					ws.bb,
					chat,
					thread.id,
					`tool:${id}`,
				);
				expect(evidence.kind).toBe("tool");
				expect(JSON.parse(evidence.content)).toMatchObject({
					messageId: done.message.id,
					toolCallId: id,
					result: id === "r1" ? "first\n" : "second\n",
				});
			}
		} finally {
			await run.cleanup();
		}
	});

	test("done settles incomplete groups without inventing tool results or footprints", async () => {
		const run = await replay([init, frame("pending", tools), success]);
		try {
			const live = run.emitted.find((event) => event.type === "parts");
			expect(live?.parts[0]).toMatchObject({
				type: "collapsed-group",
				active: true,
			});
			const done = run.emitted.find((event) => event.type === "done");
			expect(done?.message.parts?.[0]).toMatchObject({
				type: "collapsed-group",
				active: false,
			});
			expect(
				flattenToolParts(done?.message.parts).every(
					(tool) => tool.result === undefined,
				),
			).toBe(true);
			expect(await run.ws.bb.sessions.footprint(run.thread.id)).toEqual([]);
			expect((await run.chat.messages(run.thread.id)).at(-1)).toEqual(
				done?.message,
			);
		} finally {
			await run.cleanup();
		}
	});
});
