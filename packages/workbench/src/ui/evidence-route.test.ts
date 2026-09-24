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
		// %ZZ 探针必须能区分「服务端拒收」和「请求根本没出去」：先把同一
		// origin 上的合法请求再走一遍，证明服务器此刻可达、loopback 没被代理
		// 吞掉——否则下面的失败什么也证明不了。
		expect(
			(await fetch(`${root}/${thread.id}/evidence?ref=${ref}`, { headers }))
				.status,
		).toBe(200);
		try {
			const status = String(
				(await fetch(`${root}/%ZZ/evidence?ref=${ref}`, { headers })).status,
			);
			// 请求到达了 handler ⇒ 非法引用必须被拒（server.ts 的
			// decodeURIComponent catch 返回 400），放行就是回归。
			expect(status).toBe("400");
		} catch (error) {
			// 请求没到达 handler：只有 HTTP 解析层对非法百分号编码的断开
			// 算「拒收」。Bun 1.3.14 在部分版本上会直接断开含 %ZZ 的请求，
			// fetch 以 ECONNRESET 失败。连接被拒 / 超时 / DNS 失败说明请求
			// 从未离开客户端（本机的注入代理就会这样），不能算作服务端拒收
			// ——这两条断言就是用来把二者分开的。
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code ?? "")
					: "";
			const message = error instanceof Error ? error.message : String(error);
			const detail = `${code} ${message}`;
			expect(detail).not.toMatch(
				/ECONNREFUSED|ConnectionRefused|Unable to connect|timed? ?out|ENOTFOUND|EAI_AGAIN/i,
			);
			expect(detail).toMatch(
				/ECONNRESET|EPIPE|reset|invalid|illegal|parse|percent|%ZZ/i,
			);
		}
		expect(
			(await fetch(`${root}/missing/evidence?ref=${ref}`, { headers })).status,
		).toBe(404);
		expect(await ws.bb.events.all()).toEqual(events);
	} finally {
		server.stop(true);
		await ws.cleanup();
	}
});
