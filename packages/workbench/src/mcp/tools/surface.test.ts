import { describe, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { makeTempWorkbench } from "../../test/fixtures";
import { findMcpTool, MCP_TOOL_NAMES, MCP_TOOLS } from "./index";

/**
 * 表面漂移测试（TF-0328）。
 *
 * 工具目录是一条对模型承诺的表面：名字、描述、schema、体积上限都是契约。
 * 这里断言的是「目录本身」而不是某个实现细节：
 *
 * 1. 条数与顺序由 `MCP_TOOL_NAMES` 这张表决定，改一个工具必须同时改表；
 * 2. 每条工具的名字、描述、schema 都真的存在，且名字不重复；
 * 3. 每条工具在当前账本上真的可调用，返回非空文本；
 * 4. 每条工具都是只读的——调用前后账本事件数不变。
 *
 * 失败必须是硬失败（测试红），不允许静默通过。
 */

const READ_ONLY_TOOL_COUNT = 6;

describe("MCP 工具目录", () => {
	test("目录条数是 6，且与名字表逐条对齐", () => {
		expect(MCP_TOOLS.length).toBe(READ_ONLY_TOOL_COUNT);
		expect(MCP_TOOL_NAMES.length).toBe(READ_ONLY_TOOL_COUNT);
		expect(MCP_TOOLS.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
	});

	test("每条工具的名字、描述与 schema 都是可下发的契约", () => {
		const names = new Set<string>();
		for (const tool of MCP_TOOLS) {
			expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
			expect(names.has(tool.name)).toBe(false);
			names.add(tool.name);
			// 描述是模型看到的唯一说明：空描述等于没写。
			expect(tool.description.trim().length).toBeGreaterThan(8);
			// 只读意图必须写在描述里，模型据此判断能不能拿它当动作。
			expect(tool.description).toContain("只读");
			const schema = tool.inputSchema as {
				type?: string;
				properties?: Record<string, unknown>;
			};
			expect(schema.type).toBe("object");
			expect(schema.properties).toBeTypeOf("object");
		}
	});

	test("每条工具都能按名字查到", () => {
		for (const name of MCP_TOOL_NAMES) {
			expect(findMcpTool(name)?.name).toBe(name);
		}
		expect(findMcpTool("no-such-tool")).toBeUndefined();
	});

	test("每条工具在空账本上逐条可调用，且调用不写账本", async () => {
		const ws = await makeTempWorkbench();
		try {
			const before = (await ws.bb.events.all()).length;
			for (const tool of MCP_TOOLS) {
				const text = await tool.run({}, ws.bb);
				expect(text.trim().length, `${tool.name} 返回空文本`).toBeGreaterThan(
					0,
				);
			}
			const after = (await ws.bb.events.all()).length;
			// 只读边界（ADR-0023 / ADR-0027）：查询不落事件。
			expect(after).toBe(before);
		} finally {
			await ws.cleanup();
		}
	});

	test("continuity：0 / 1 / 多条线程三种形态，线程不存在时给可读错误", async () => {
		const ws = await makeTempWorkbench();
		try {
			const tool = findMcpTool("continuity");
			expect(tool).toBeDefined();

			// 0 条线程
			expect(await tool!.run({}, ws.bb)).toContain("还没有对话线程");

			const { ChatThreads } = await import("../../chat/threads");
			const chat = new ChatThreads(ws.bb);
			const interrupted = await chat.create("被切断的会话");
			await ws.bb.events.appendThread("thread.turn_interrupted", {
				threadId: interrupted.id,
				at: new Date().toISOString(),
				atMessageCount: 0,
				reason: "host-restarted",
			});
			await new Promise((resolve) => setTimeout(resolve, 5));
			const healthy = await chat.create("健康的会话");
			await appendFile(
				join(ws.workbenchRoot, "threads", healthy.id, "messages.jsonl"),
				`${JSON.stringify({
					id: "m-1",
					role: "user",
					text: "你好",
					at: new Date().toISOString(),
				})}\n${JSON.stringify({
					id: "m-2",
					role: "assistant",
					text: "你好，有什么可以做的",
					at: new Date().toISOString(),
				})}\n`,
				"utf8",
			);

			// 1 条线程：详情读数带中断行与可核对引用
			const detail = await tool!.run({ threadId: interrupted.id }, ws.bb);
			expect(detail).toContain(interrupted.id);
			expect(detail).toContain("需要人看一眼");
			expect(detail).toContain("host-restarted");
			expect(detail).toContain("之后没有回复");
			expect(detail).toContain("可核对");

			// 多条线程：计数 + 逐行标记
			const all = await tool!.run({}, ws.bb);
			expect(all).toContain("共 2 条会话");
			expect(all).toContain("需要人看一眼 1");
			expect(all).toContain(`- ${interrupted.id} !`);
			expect(all).toContain(`- ${healthy.id} -`);

			// 不存在的线程：可读错误，不是抛出崩溃
			const missing = await tool!.run({ threadId: "no-such-thread" }, ws.bb);
			expect(missing).toContain("无法读取会话");
			expect(missing).toContain("no-such-thread");
		} finally {
			await ws.cleanup();
		}
	});

	test("continuity：响应顶过上限时被截断并标注剩余字符", async () => {
		const ws = await makeTempWorkbench();
		try {
			const { ChatThreads } = await import("../../chat/threads");
			const chat = new ChatThreads(ws.bb);
			for (let i = 0; i < 40; i += 1) {
				const meta = await chat.create(`会话-${i}-${"长".repeat(120)}`);
				await ws.bb.events.appendThread("thread.turn_interrupted", {
					threadId: meta.id,
					at: new Date().toISOString(),
					atMessageCount: 0,
					reason: "host-restarted",
				});
			}
			const text = await findMcpTool("continuity")!.run({ limit: 100 }, ws.bb);
			expect(text).toContain("已截断");
		} finally {
			await ws.cleanup();
		}
	});
});
