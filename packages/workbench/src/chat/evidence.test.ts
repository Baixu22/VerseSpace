import { expect, test } from "bun:test";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { resolveThreadEvidence } from "./evidence";
import { ChatThreads, type StoredMessage } from "./threads";

test("证据引用解析原始消息、工具、足迹和事件，路径引用不读取当前文件", async () => {
	const ws = await makeTempWorkbench();
	try {
		const chat = new ChatThreads(ws.bb);
		const thread = await chat.create();
		const messages: StoredMessage[] = [
			{
				id: "question",
				role: "user",
				text: "实现证据查看",
				at: new Date().toISOString(),
			},
			{
				id: "answer",
				role: "assistant",
				text: "已读取历史版本",
				at: new Date().toISOString(),
				parts: [
					{
						type: "tool-call",
						toolCallId: "read-1",
						toolName: "Read",
						args: { file_path: "a.ts" },
						result: "historical content",
					},
				],
			},
		];
		await appendFile(
			join(ws.workbenchRoot, "threads", thread.id, "messages.jsonl"),
			`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
		);
		await ws.bb.sessions.recordActivity(thread.id, {
			activity: "read-1",
			agent: thread.id,
			used: [{ path: "a.ts", version: "observed-version" }],
			generated: [],
		});
		await writeFile(
			join(ws.projectDir, "a.ts"),
			"current file must not replace the record",
		);
		await chat.promote(thread.id);
		await chat.fork(thread.id, "question");
		const footprint = (await ws.bb.sessions.footprint(thread.id))[0]!;
		const events = await ws.bb.events.all();
		const event = events.find((item) => item.id === footprint.eventId)!;
		const resolve = (ref: string) =>
			resolveThreadEvidence(ws.bb, chat, thread.id, ref);
		for (const ref of [
			event.id!,
			`eventSeq:${event.eventSeq}`,
			`footprint:${event.id}`,
		]) {
			const source = await resolve(ref);
			expect(source.kind).toBe("footprint");
			expect(JSON.parse(source.content)).toMatchObject({
				id: event.id,
				type: "footprint",
			});
		}
		expect(JSON.parse((await resolve("footprintSeq:1")).content)).toMatchObject(
			{ seq: 1, activity: "read-1" },
		);
		expect(JSON.parse((await resolve("message:question")).content)).toEqual(
			messages[0],
		);
		expect(JSON.parse((await resolve("tool:read-1")).content)).toMatchObject({
			messageId: "answer",
			result: "historical content",
		});
		expect((await resolve("ledger:question")).kind).toBe("ledger");
		expect((await resolve("promotion")).kind).toBe("promotion");
		for (const ref of ["path:a.ts", `path:${join(ws.projectDir, "a.ts")}`]) {
			const source = await resolve(ref);
			expect(source.kind).toBe("path");
			expect(source.content).toContain("observed-version");
			expect(source.content).not.toContain(
				"current file must not replace the record",
			);
		}
		expect(await ws.bb.events.all()).toEqual(events);
	} finally {
		await ws.cleanup();
	}
});

test("本地足迹序号与消息限定在当前线程，缺失或旧引用显式不可用", async () => {
	const ws = await makeTempWorkbench();
	try {
		const chat = new ChatThreads(ws.bb);
		const a = await chat.create();
		const b = await chat.create();
		for (const thread of [a, b]) {
			await ws.bb.sessions.recordActivity(thread.id, {
				activity: thread.id,
				agent: thread.id,
				used: [{ path: `${thread.id}.ts` }],
				generated: [],
			});
		}
		const own = await resolveThreadEvidence(
			ws.bb,
			chat,
			a.id,
			"footprintSeq:1",
		);
		expect(own.content).toContain(a.id);
		expect(own.content).not.toContain(b.id);
		for (const ref of [
			"message:missing",
			"tool:missing",
			"ledger:missing",
			"footprintSeq:999",
			"eventSeq:bad",
			"path:../../untracked",
			"legacy:doing",
			"suggest:next",
			"event:unknown",
		]) {
			const result = await resolveThreadEvidence(ws.bb, chat, a.id, ref);
			expect(result.kind).toBe("unavailable");
			expect(result.content.length).toBeGreaterThan(0);
		}
		const created = (await ws.bb.events.query({ type: "thread.created" }))[0]!;
		expect(
			(
				await resolveThreadEvidence(
					ws.bb,
					chat,
					a.id,
					`footprint:${created.id}`,
				)
			).kind,
		).toBe("unavailable");
	} finally {
		await ws.cleanup();
	}
});

test("证据预览有上限且明确标出截断，原文不改写", async () => {
	const ws = await makeTempWorkbench();
	try {
		const chat = new ChatThreads(ws.bb);
		const thread = await chat.create();
		const event = await ws.bb.events.append({
			timestamp: new Date().toISOString(),
			source: "test",
			type: "large-evidence",
			payload: { text: "a".repeat(100_000) },
		});
		const result = await resolveThreadEvidence(
			ws.bb,
			chat,
			thread.id,
			event.id!,
		);
		expect(result.truncated).toBe(true);
		expect(result.content.length).toBeLessThanOrEqual(16_000);
		expect(
			(await ws.bb.events.all()).find((item) => item.id === event.id)?.payload,
		).toEqual(event.payload);
	} finally {
		await ws.cleanup();
	}
});

test("工具 ID 被不同轮次复用时列出全部候选，不把第一条当作唯一来源", async () => {
	const ws = await makeTempWorkbench();
	try {
		const chat = new ChatThreads(ws.bb);
		const thread = await chat.create();
		const messages: StoredMessage[] = ["first", "second"].map((id) => ({
			id,
			role: "assistant",
			text: id,
			at: new Date().toISOString(),
			parts: [
				{
					type: "tool-call",
					toolCallId: "reused",
					toolName: "Read",
					args: { path: `${id}.ts` },
					result: id,
				},
			],
		}));
		await appendFile(
			join(ws.workbenchRoot, "threads", thread.id, "messages.jsonl"),
			`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
		);
		const result = await resolveThreadEvidence(
			ws.bb,
			chat,
			thread.id,
			"tool:reused",
		);
		expect(result.title).toContain("2 条匹配记录");
		expect(
			JSON.parse(result.content).map(
				(item: { messageId: string }) => item.messageId,
			),
		).toEqual(["first", "second"]);
	} finally {
		await ws.cleanup();
	}
});
