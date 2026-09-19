import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import { makeTempWorkbench } from "../test/fixtures";
import { WORKBENCH_VERSION } from "../version";
import { MCP_PROTOCOL_VERSION } from "./protocol";
import { handleRequest } from "./server";
import { MCP_TOOLS } from "./tools";

async function withBb<T>(
	fn: (bb: Awaited<ReturnType<typeof makeTempWorkbench>>["bb"]) => Promise<T>,
): Promise<T> {
	const ws = await makeTempWorkbench();
	try {
		return await fn(ws.bb);
	} finally {
		await ws.cleanup();
	}
}

test("initialize：返回协议版本、能力与服务器信息", async () => {
	await withBb(async (bb) => {
		const res = await handleRequest(
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "test", version: "0" },
				},
			},
			bb,
		);
		expect(res).not.toBeNull();
		expect(res!.id).toBe(1);
		const result = res!.result as {
			protocolVersion: string;
			capabilities: { tools: { listChanged: boolean } };
			serverInfo: { name: string; version: string };
		};
		expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
		expect(result.capabilities.tools.listChanged).toBe(false);
		expect(result.serverInfo.name).toBe("workbench");
		expect(result.serverInfo.version).toBe(WORKBENCH_VERSION);
	});
});

test("ping：返回空 result", async () => {
	await withBb(async (bb) => {
		const res = await handleRequest(
			{ jsonrpc: "2.0", id: 2, method: "ping" },
			bb,
		);
		expect(res?.result).toEqual({});
	});
});

test("tools/list：暴露五个工具且带 inputSchema", async () => {
	await withBb(async (bb) => {
		const res = await handleRequest(
			{ jsonrpc: "2.0", id: 3, method: "tools/list" },
			bb,
		);
		const tools = (
			res!.result as { tools: Array<{ name: string; inputSchema: unknown }> }
		).tools;
		expect(tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));
		for (const tool of tools) {
			expect(tool.inputSchema).toBeTypeOf("object");
		}
	});
});

test("tools/call：调用 premises 返回文本内容", async () => {
	await withBb(async (bb) => {
		const res = await handleRequest(
			{
				jsonrpc: "2.0",
				id: 4,
				method: "tools/call",
				params: { name: "premises", arguments: {} },
			},
			bb,
		);
		const result = res!.result as {
			content: Array<{ type: string; text: string }>;
			isError: boolean;
		};
		expect(result.isError).toBe(false);
		expect(result.content[0]!.type).toBe("text");
		expect(result.content[0]!.text).toContain("没有待投递的前提失效通知");
	});
});

test("tools/call：未知工具返回 Invalid params", async () => {
	await withBb(async (bb) => {
		const res = await handleRequest(
			{ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } },
			bb,
		);
		expect(res!.error?.code).toBe(-32602);
	});
});

test("tools/call：缺工具名返回 Invalid params", async () => {
	await withBb(async (bb) => {
		const res = await handleRequest(
			{ jsonrpc: "2.0", id: 6, method: "tools/call", params: {} },
			bb,
		);
		expect(res!.error?.code).toBe(-32602);
	});
});

test("未知方法返回 Method not found", async () => {
	await withBb(async (bb) => {
		const res = await handleRequest(
			{ jsonrpc: "2.0", id: 7, method: "bogus" },
			bb,
		);
		expect(res!.error?.code).toBe(-32601);
	});
});

test("通知（无 id）不产生响应", async () => {
	await withBb(async (bb) => {
		const res = await handleRequest(
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			bb,
		);
		expect(res).toBeNull();
	});
});

test("workbench mcp 子进程握手（MCP Inspector 式）", async () => {
	const ws = await makeTempWorkbench();
	const entry = resolve(import.meta.dir, "..", "index.ts");
	const proc = spawn(process.execPath, [entry, "mcp"], {
		cwd: ws.projectDir,
		windowsHide: true,
	});
	const lines = createInterface({ input: proc.stdout });
	const pending = new Map<
		number | string,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	lines.on("line", (line) => {
		if (!line.trim()) return;
		let message: { id?: number | string; result?: unknown; error?: unknown };
		try {
			message = JSON.parse(line) as typeof message;
		} catch {
			return;
		}
		if (message.id === undefined) return;
		const waiter = pending.get(message.id);
		if (!waiter) return;
		pending.delete(message.id);
		if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
		else waiter.resolve(message.result);
	});
	const send = <T>(
		id: number | string,
		method: string,
		params?: unknown,
	): Promise<T> =>
		new Promise<T>((resolveSend, rejectSend) => {
			pending.set(id, {
				resolve: resolveSend as (v: unknown) => void,
				reject: rejectSend,
			});
			proc.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`,
			);
		});
	try {
		const init = await send<{
			protocolVersion: string;
			capabilities: { tools: { listChanged: boolean } };
			serverInfo: { name: string; version: string };
		}>(1, "initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "test", version: "0" },
		});
		expect(init.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
		expect(init.serverInfo.name).toBe("workbench");
		expect(init.serverInfo.version).toBe(WORKBENCH_VERSION);

		// 通知无需回包：只写不读，服务端不应崩溃。
		proc.stdin.write(
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
		);

		const list = await send<{ tools: Array<{ name: string }> }>(
			2,
			"tools/list",
		);
		expect(list.tools.map((t) => t.name)).toEqual(MCP_TOOLS.map((t) => t.name));

		const call = await send<{
			content: Array<{ type: string; text: string }>;
			isError: boolean;
		}>(3, "tools/call", { name: "premises", arguments: {} });
		expect(call.isError).toBe(false);
		expect(call.content[0]!.text).toContain("没有待投递的前提失效通知");
	} finally {
		proc.kill();
		await new Promise((resolveKill) => proc.on("exit", resolveKill));
		await ws.cleanup();
	}
});
