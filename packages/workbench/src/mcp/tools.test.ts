import { expect, test } from "bun:test";

import { makeTempWorkbench } from "../test/fixtures";
import {
	DEFAULT_TRUNCATION_CHARS,
	findMcpTool,
	MCP_TOOLS,
	truncate,
} from "./tools";

test("truncate：超长文本截断到上限并标注", () => {
	const long = "x".repeat(3_000);
	const out = truncate(long);
	expect(out.length).toBeLessThanOrEqual(DEFAULT_TRUNCATION_CHARS);
	expect(out).toContain("已截断");
	const short = "short";
	expect(truncate(short)).toBe(short);
});

test("每个工具的响应都不超过体积上限（TF-0211 AC）", async () => {
	for (const tool of MCP_TOOLS) {
		const ws = await makeTempWorkbench();
		try {
			const text = await tool.run({}, ws.bb);
			expect(
				text.length,
				`${tool.name} 响应 ${text.length} 字符超过上限 ${DEFAULT_TRUNCATION_CHARS}`,
			).toBeLessThanOrEqual(DEFAULT_TRUNCATION_CHARS);
		} finally {
			await ws.cleanup();
		}
	}
});

test("premises：待投递的前提失效通知来自 premise_stale 事件", async () => {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.events.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type: "premise_stale",
			payload: {
				writer: "thread-1",
				noticeId: "n-1",
				stale: [
					{
						path: "src/alpha.ts",
						observedVersion: "v1",
						currentVersion: "v2",
						diff: "v1 -> v2",
					},
				],
			},
		});
		const tool = findMcpTool("premises");
		expect(tool).toBeDefined();
		const text = await tool!.run({}, ws.bb);
		expect(text).toContain("thread-1");
		expect(text).toContain("src/alpha.ts");
		expect(text).toContain("有 diff");
	} finally {
		await ws.cleanup();
	}
});

test("footprints：读取 footprint 事件中的读/写路径", async () => {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.events.append({
			timestamp: new Date().toISOString(),
			source: "sessions",
			type: "footprint",
			payload: {
				writer: "thread-1",
				activity: "toolu_1",
				used: [{ path: "src/alpha.ts" }],
				generated: [{ path: "src/beta.ts" }],
				facets: { tool: "Read" },
			},
		});
		const tool = findMcpTool("footprints");
		const text = await tool!.run({ writer: "thread-1" }, ws.bb);
		expect(text).toContain("src/alpha.ts");
		expect(text).toContain("Read");
	} finally {
		await ws.cleanup();
	}
});

test("resume_cards：无恢复笔记时给出空态；指定线程无卡时给出说明", async () => {
	const ws = await makeTempWorkbench();
	try {
		const tool = findMcpTool("resume_cards");
		const empty = await tool!.run({}, ws.bb);
		expect(empty).toContain("没有带恢复笔记的线程");
		const { ChatThreads } = await import("../chat/threads");
		const chat = new ChatThreads(ws.bb);
		const meta = await chat.create("测试线程");
		const byId = await tool!.run({ threadId: meta.id }, ws.bb);
		expect(byId).toContain("没有恢复卡");
	} finally {
		await ws.cleanup();
	}
});

test("tribunal：提交条目后出现在列表里", async () => {
	const ws = await makeTempWorkbench();
	try {
		const empty = await findMcpTool("tribunal")!.run({}, ws.bb);
		expect(empty).toContain("裁决队列为空");
		const submitted = await ws.bb.tribunal.submit({
			kind: "workspot_blocked",
			subject: "ws-a",
			causeKey: "test:blocked",
			action: { label: "重新派发" },
			sbar: {
				situation: "工位被阻塞",
				background: "前提失效",
				assessment: "需要人工判断",
				recommendation: "人工复核",
			},
		});
		expect(submitted.admitted).toBe(true);
		const text = await findMcpTool("tribunal")!.run({}, ws.bb);
		expect(text).toContain("ws-a");
		expect(text).toContain("workspot_blocked");
	} finally {
		await ws.cleanup();
	}
});

test("notices：读取 premise_notice_delivered 投递记录与待投递数", async () => {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.events.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type: "premise_notice_delivered",
			payload: {
				writer: "thread-1",
				noticeIds: ["n-1"],
				count: 1,
				readObservability: true,
			},
		});
		const text = await findMcpTool("notices")!.run({}, ws.bb);
		expect(text).toContain("thread-1");
		expect(text).toContain("count=1");
	} finally {
		await ws.cleanup();
	}
});
