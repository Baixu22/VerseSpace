import { expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatThreads } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import { createUiServer } from "./server";

test("手动命名入口只对有内容的无名对话开放，重复请求保留用户标题", async () => {
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
		expect((await fetch(`${url}/promote`, { method: "POST" })).status).toBe(
			401,
		);
		expect(await (await fetch(url, { headers })).json()).toMatchObject({
			canPromote: false,
			resumeDelta: 0,
		});
		await appendFile(
			join(ws.workbenchRoot, "threads", thread.id, "messages.jsonl"),
			`${JSON.stringify({
				id: "user-1",
				role: "user",
				text: "修复目录扫描",
				at: new Date().toISOString(),
			})}\n`,
		);
		expect(await (await fetch(url, { headers })).json()).toMatchObject({
			canPromote: true,
		});
		const promoted = await fetch(`${url}/promote`, { method: "POST", headers });
		expect(promoted.status).toBe(200);
		expect(await promoted.json()).toMatchObject({
			id: thread.id,
			title: "修复目录扫描",
		});
		expect(await (await fetch(url, { headers })).json()).toMatchObject({
			canPromote: false,
		});
		await fetch(url, {
			method: "PATCH",
			headers,
			body: JSON.stringify({ title: "用户自己的标题" }),
		});
		expect(
			await (await fetch(`${url}/promote`, { method: "POST", headers })).json(),
		).toMatchObject({ title: "用户自己的标题" });
	} finally {
		server.stop(true);
		await ws.cleanup();
	}
});
