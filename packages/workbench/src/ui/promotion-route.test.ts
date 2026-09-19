import { expect, test } from "bun:test";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatThreads, type ThreadMeta } from "../chat/threads";
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

const jsonHeaders = (token: string) => ({
	"x-workbench-token": token,
	"content-type": "application/json",
});

test("收养/反转：分支升主线、源归档，反转身份复原，事件各落一次（TF-0200）", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	const source = await chat.create();
	await appendFile(
		join(ws.workbenchRoot, "threads", source.id, "messages.jsonl"),
		`${JSON.stringify({ id: "user-1", role: "user", text: "调研收养", at: new Date().toISOString() })}\n`,
	);
	const child = (await chat.fork(source.id, "user-1")).thread!;
	const server = await createUiServer(ws.bb, 0);
	const base = `http://127.0.0.1:${server.port}/api/chat/threads`;
	const meta = async (id: string) =>
		JSON.parse(
			await readFile(
				join(ws.workbenchRoot, "threads", id, "meta.json"),
				"utf8",
			),
		) as ThreadMeta;
	try {
		const adopted = await fetch(`${base}/${child.id}/adopt`, {
			method: "POST",
			headers: jsonHeaders(server.authToken),
		});
		expect(adopted.status).toBe(200);
		expect(await adopted.json()).toMatchObject({ ok: true });
		// 源归档、子清空血统——身份翻转但双方消息不动
		expect((await meta(source.id)).archived).toBe(true);
		expect((await meta(child.id)).forkOf).toBeUndefined();
		expect(await ws.bb.events.query({ type: "thread.adopted" })).toHaveLength(
			1,
		);

		const reverted = await fetch(`${base}/${source.id}/revert`, {
			method: "POST",
			headers: jsonHeaders(server.authToken),
		});
		expect(reverted.status).toBe(200);
		// 身份复原：源解档、快照消费、子血统还原
		expect((await meta(source.id)).archived).toBe(false);
		expect((await meta(source.id)).adoptSnapshot).toBeUndefined();
		expect((await meta(child.id)).forkOf).toMatchObject({
			sourceThreadId: source.id,
		});
		expect(
			await ws.bb.events.query({ type: "thread.adoption_reverted" }),
		).toHaveLength(1);
	} finally {
		server.stop(true);
		await ws.cleanup();
	}
});

test("收养错误臂：非分叉线程无 forkOf 血统，adopt 返回 400（TF-0200）", async () => {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	const plain = await chat.create();
	const server = await createUiServer(ws.bb, 0);
	try {
		const res = await fetch(
			`http://127.0.0.1:${server.port}/api/chat/threads/${plain.id}/adopt`,
			{ method: "POST", headers: jsonHeaders(server.authToken) },
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ ok: false });
	} finally {
		server.stop(true);
		await ws.cleanup();
	}
});
