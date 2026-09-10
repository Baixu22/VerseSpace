import { expect, test } from "bun:test";
import { ChatThreads } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import { createUiServer } from "./server";

test("证据接口要求认证，拒绝无效引用和目录越界，读取不生成事件", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	const thread = await chat.create();
	const server = await createUiServer(ws.bb, 0);
	const root = `http://127.0.0.1:${server.port}/api/chat/threads`;
	const headers = { "x-workbench-token": server.authToken };
	try {
		const events = await ws.bb.events.all();
		const ref = events[0]!.id!;
		const url = `${root}/${thread.id}/evidence?ref=${encodeURIComponent(ref)}`;
		expect((await fetch(url)).status).toBe(401);
		const response = await fetch(url, { headers });
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ref,
			kind: "event",
			truncated: false,
		});
		expect(
			(await fetch(`${root}/${thread.id}/evidence`, { headers })).status,
		).toBe(400);
		expect(
			(
				await fetch(`${root}/${thread.id}/evidence?ref=${"a".repeat(2_049)}`, {
					headers,
				})
			).status,
		).toBe(400);
		expect(
			(await fetch(`${root}/..%2Foutside/evidence?ref=${ref}`, { headers }))
				.status,
		).toBe(400);
		expect(
			(await fetch(`${root}/%ZZ/evidence?ref=${ref}`, { headers })).status,
		).toBe(400);
		expect(
			(await fetch(`${root}/missing/evidence?ref=${ref}`, { headers })).status,
		).toBe(404);
		expect(await ws.bb.events.all()).toEqual(events);
	} finally {
		server.stop(true);
		await ws.cleanup();
	}
});
