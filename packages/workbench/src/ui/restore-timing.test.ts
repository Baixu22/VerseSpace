import { expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { collectChatStats } from "../chat/stats";
import { ChatThreads, type StoredMessage } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import { createUiServer } from "./server";

test("恢复观测经 HTTP 落库并进入 stats；GET 不记样本，坏字段被拒绝", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	const thread = await chat.create();
	const server = await createUiServer(ws.bb, 0);
	const headers = {
		"x-workbench-token": server.authToken,
		"content-type": "application/json",
	};
	const url = `http://127.0.0.1:${server.port}/api/chat/threads/${thread.id}`;
	try {
		const before = await ws.bb.events.all();
		expect((await fetch(url, { headers })).status).toBe(200);
		expect(await ws.bb.events.all()).toEqual(before);
		for (const body of [
			null,
			{ resumeCardVisible: "false" },
			{ lastMessageId: 123 },
		]) {
			expect(
				(
					await fetch(`${url}/restore`, {
						method: "POST",
						headers,
						body: JSON.stringify(body),
					})
				).status,
			).toBe(400);
		}
		expect(await ws.bb.events.all()).toEqual(before);
		expect(
			(
				await fetch(`${url}/restore`, {
					method: "POST",
					headers,
					body: JSON.stringify({
						resumeCardVisible: false,
						lastMessageId: null,
						threadId: "wrong",
					}),
				})
			).status,
		).toBe(200);
		const restored = (await ws.bb.events.all()).at(-1)!;
		expect(restored.payload).toMatchObject({
			threadId: thread.id,
			resumeCardVisible: false,
			lastMessageId: null,
		});
		const message: StoredMessage = {
			id: "first-new-prompt",
			role: "user",
			text: "继续",
			at: new Date().toISOString(),
		};
		await appendFile(
			join(ws.workbenchRoot, "threads", thread.id, "messages.jsonl"),
			`${JSON.stringify(message)}\n`,
		);
		const eventsBeforeStats = await ws.bb.events.all();
		const stats = await collectChatStats(ws.bb);
		expect(stats.lifecycle.restoreToMessage.withoutCard).toEqual({
			samples: 1,
			medianMs: Date.parse(message.at) - Date.parse(restored.timestamp),
		});
		expect(stats.lifecycle.restoreToMessage.exceeds20Percent).toBeNull();
		expect(await ws.bb.events.all()).toEqual(eventsBeforeStats);
		// Older clients may omit observations, but absence never becomes false.
		expect(
			(await fetch(`${url}/restore`, { method: "POST", headers, body: "{}" }))
				.status,
		).toBe(200);
		expect((await ws.bb.events.all()).at(-1)!.payload).not.toHaveProperty(
			"resumeCardVisible",
		);
	} finally {
		server.stop(true);
		await ws.cleanup();
	}
});
