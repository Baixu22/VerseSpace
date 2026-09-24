import { expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { makeTempWorkbench, type TempWorkbench } from "../test/fixtures";
import {
	DEFAULT_TRUNCATION_CHARS,
	findMcpTool,
	MCP_TOOLS,
	truncate,
} from "./tools";

/** 够长的路径：让每个工具的自然响应都能顶过 DEFAULT_TRUNCATION_CHARS。 */
function longPath(tag: string, index: number): string {
	return `src/features/${tag}/nested-directory-${index}/module-with-a-very-long-file-name-${index}.ts`;
}

/**
 * 把账本填到「五个工具各自的自然响应都远超过 2000 字符」——空账本会让五个
 * 工具全部走空态早退，`truncate` 一次都不执行，体积上限这条 AC 就变成空转。
 * 每个工具靠什么变长（见 src/mcp/tools.ts）：
 * - premises：premise_stale 事件（每个写者一条通知，claims 越多越长）；
 * - notices：premise_notice_delivered 投递记录（默认取最近 10 条）；
 * - footprints：footprint 事件的 used/generated 路径（默认取最近 20 条）；
 * - resume_cards：带恢复笔记的线程标题（默认取 10 条）；
 * - tribunal：裁决项的 subject/causeKey（默认取 10 条）。
 */
async function seedOversizedLedger(ws: TempWorkbench): Promise<void> {
	const at = new Date().toISOString();
	// premises：12 个写者 × 3 条长路径失效前提 → 10 条通知，每条 3 行 claims。
	await ws.bb.events.appendMany(
		Array.from({ length: 12 }, (_, i) => ({
			timestamp: at,
			source: "runtime",
			type: "premise_stale",
			payload: {
				writer: `writer-with-a-long-name-${i}`,
				noticeId: `n-${i}`,
				stale: [0, 1, 2].map((k) => ({
					path: longPath(`stale-${i}-${k}`, k),
					observedVersion: `observed-version-${i}-${k}`,
					currentVersion: `current-version-${i}-${k}`,
					diff: `diff-${i}-${k}`,
				})),
			},
		})),
	);
	// notices：12 条投递记录，写者名本身很长（每条一行，默认取 10 条）。
	await ws.bb.events.appendMany(
		Array.from({ length: 12 }, (_, i) => ({
			timestamp: at,
			source: "runtime",
			type: "premise_notice_delivered",
			payload: {
				writer: `delivered-${"w".repeat(200)}-${i}`,
				count: i + 1,
				readObservability: true,
			},
		})),
	);
	// footprints：25 条足迹事件，每条带 2 读 1 写（默认取最近 20 条）。
	await ws.bb.events.appendMany(
		Array.from({ length: 25 }, (_, i) => ({
			timestamp: at,
			source: "sessions",
			type: "footprint",
			payload: {
				writer: `thread-${i}`,
				activity: `toolu_${i}`,
				used: [
					{ path: longPath(`used-a-${i}`, i) },
					{ path: longPath(`used-b-${i}`, i) },
				],
				generated: [{ path: longPath(`generated-${i}`, i) }],
				facets: { tool: `Tool-With-A-Long-Name-${i}` },
			},
		})),
	);
	// resume_cards：12 条带恢复笔记的线程，标题很长（默认取 10 条）。
	const { ChatThreads } = await import("../chat/threads");
	const chat = new ChatThreads(ws.bb);
	for (let i = 0; i < 12; i += 1) {
		const meta = await chat.create(`恢复笔记线程-${i}-${"长".repeat(300)}`);
		await appendFile(
			join(ws.workbenchRoot, "threads", meta.id, "messages.jsonl"),
			`${JSON.stringify({
				id: `m-${i}`,
				role: "user",
				text: `第 ${i} 个线程离开时在做的事情`,
				at,
			})}\n`,
			"utf8",
		);
		await chat.leave(meta.id);
	}
	// tribunal：12 条待裁决项，subject 很长（默认取 10 条）。
	for (let i = 0; i < 12; i += 1) {
		await ws.bb.tribunal.submit({
			kind: "workspot_blocked",
			subject: `workspot-with-a-long-name-${i}-${"s".repeat(150)}`,
			causeKey: `test:oversize:${i}`,
			action: { label: "重新派发" },
			sbar: {
				situation: "工位被阻塞",
				background: "前提失效",
				assessment: "需要人工判断",
				recommendation: "人工复核",
			},
		});
	}
}

test("truncate：超长文本截断到上限并标注", () => {
	const long = "x".repeat(3_000);
	const out = truncate(long);
	expect(out.length).toBeLessThanOrEqual(DEFAULT_TRUNCATION_CHARS);
	expect(out).toContain("已截断");
	const short = "short";
	expect(truncate(short)).toBe(short);
});

test("每个工具的响应都不超过体积上限（TF-0211 AC）", async () => {
	// 五个工具都是只读的（不写账本），所以一份「足够大」的账本可以依次喂给
	// 五个工具——每个工具都必须在真实数据上触发截断，而不是走空态早退。
	const ws = await makeTempWorkbench();
	try {
		await seedOversizedLedger(ws);
		for (const tool of MCP_TOOLS) {
			const text = await tool.run({}, ws.bb);
			expect(
				text.length,
				`${tool.name} 响应 ${text.length} 字符超过上限 ${DEFAULT_TRUNCATION_CHARS}`,
			).toBeLessThanOrEqual(DEFAULT_TRUNCATION_CHARS);
			// 只断言「不超过上限」的话，空态早退（或任何短响应）也算通过，
			// 删掉 truncate() 一样绿。截断标记只在 truncate() 真正裁掉内容时
			// 出现——它同时证明「响应先长过上限」和「上限确实被执行了」。
			expect(text, `${tool.name} 未触发截断`).toContain("已截断");
		}
	} finally {
		await ws.cleanup();
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
