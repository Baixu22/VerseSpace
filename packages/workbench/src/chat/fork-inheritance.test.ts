/**
 * TF-0131 · 分支读集继承与诚实开关。
 *
 * TF-0140 已裁决继承语义（见 docs/report-2026-09-05-claude-fork-inheritance.md
 * 与 ADR-0010 §5）：`--fork-session` 会把源会话逐字复刻，`tool_use_id` 过 fork 不变，
 * 所以读集继承是可以做的。本文件钉的是这件事的另一半 —— **什么时候必须不声称继承**。
 *
 * 两级开关不合成一个布尔（ADR-0010 §5 的表）：
 *   agentContextInherited  fork-session 与 HTTP 历史重发都为 true，只是 mode 不同；
 *   premiseInherited（读集）只有「走 fork-session 且源足迹非空可比对」才为 true。
 *
 * 成功判据（森林节点原文）：没有合法继承路径时，inherited 事件数量为 0。
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { workbenchConfigSchema } from "../types/config";
import { ChatThreads } from "./threads";

/**
 * 假 claude：只做 TF-0131 需要的三件事 —— 回报 session id（`--fork-session` 时换新的）、
 * 按 `read:<相对路径>` 发一次真实工具调用、把 argv 落盘供断言。
 */
const FAKE_AGENT = String.raw`
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(1);
appendFileSync(join(__dirname, "argv.log"), JSON.stringify(args) + "\n");
const line = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const session = args.includes("--fork-session")
  ? "fork-" + Math.random().toString(36).slice(2, 8)
  : (args[args.indexOf("--session-id") + 1] || "parent-session");
line({ type: "system", subtype: "init", session_id: session });
let buffer = "";
let turn = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) { try { JSON.parse(buffer.trim()); } catch { break; } }
    const raw = end < 0 ? buffer.trim() : buffer.slice(0, end).trim();
    buffer = end < 0 ? "" : buffer.slice(end + 1);
    if (!raw) continue;
    const prompt = JSON.parse(raw)?.message?.content || "";
    if (prompt.startsWith("read:")) {
      turn += 1;
      const id = "read-" + turn + "-" + Math.random().toString(36).slice(2, 6);
      const target = join(process.cwd(), prompt.slice("read:".length).trim());
      line({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: target } }] } });
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "facts" }] } });
    }
    line({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    line({ type: "result", subtype: "success", result: "ok" });
    setTimeout(() => process.exit(0), 5);
    break;
  }
});
`;

interface FakeClaude {
	dir: string;
	/** 每次 spawn 的 argv，按启动顺序。 */
	argv(): Promise<string[][]>;
	restore(): Promise<void>;
}

async function fakeClaude(): Promise<FakeClaude> {
	const dir = await mkdtemp(join(tmpdir(), "wb-fork-honesty-"));
	await writeFile(join(dir, "agent.js"), FAKE_AGENT, "utf8");
	const previous = process.env.WORKBENCH_CHAT_COMMAND;
	process.env.WORKBENCH_CHAT_COMMAND = `bun ${join(dir, "agent.js")}`;
	return {
		dir,
		async argv() {
			const text = await readFile(join(dir, "argv.log"), "utf8").catch(
				() => "",
			);
			return text
				.trim()
				.split("\n")
				.filter((l) => l.length > 0)
				.map((l) => JSON.parse(l) as string[]);
		},
		async restore() {
			if (previous === undefined) delete process.env.WORKBENCH_CHAT_COMMAND;
			else process.env.WORKBENCH_CHAT_COMMAND = previous;
			await rm(dir, { recursive: true, force: true });
		},
	};
}

/**
 * 等这条线程的常驻 claude 会话退出。fork 的 plan 闸门要求源会话不在 live 里
 * （`!this.live.get(id)`），所以每轮之后都得等它真的收摊。
 */
async function settle(chat: ChatThreads, id: string): Promise<void> {
	const live = (chat as unknown as { live: Map<string, unknown> }).live;
	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (!live.has(id)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

async function runAndSettle(
	chat: ChatThreads,
	id: string,
	prompt: string,
): Promise<void> {
	await chat.run(id, prompt, () => {});
	await settle(chat, id);
}

describe("分支读集继承与诚实开关（TF-0131）", () => {
	test("中段分叉不走 fork-session：源有真实足迹也不写 inherited 读集", async () => {
		const ws = await makeTempWorkbench();
		const fake = await fakeClaude();
		try {
			await writeFile(join(ws.projectDir, "readme.md"), "source facts\n");
			const chat = new ChatThreads(ws.bb);
			const source = await chat.create();
			await runAndSettle(chat, source.id, "read:readme.md");
			await runAndSettle(chat, source.id, "第二轮");

			// 源确实攒下了可继承的足迹——否则这个测试只是在测「没数据」
			expect(
				(await ws.bb.sessions.footprint(source.id)).length,
			).toBeGreaterThan(0);
			const messages = await chat.messages(source.id);
			const midAnchor = messages.find((m) => m.role === "assistant")!;
			expect(midAnchor.id).not.toBe(messages.at(-1)!.id);

			const outcome = await chat.fork(source.id, midAnchor.id);
			expect(outcome.ok).toBe(true);
			// 锚点不是尾巴 → 没有 provider 计划，孩子从新会话开始
			expect(outcome.thread?.forkOf?.agentContextPlan).toBeUndefined();
			expect(outcome.declaration?.freshAgentSession).toBe(true);

			await runAndSettle(chat, outcome.thread!.id, "child");

			const argv = await fake.argv();
			expect(argv.at(-1)).not.toContain("--fork-session");
			expect(
				await ws.bb.events.query({ type: "footprint.inherited" }),
			).toHaveLength(0);
			const child = await chat.get(outcome.thread!.id);
			expect(child.forkInheritance).toMatchObject({
				agentContextInherited: false,
				premiseInherited: false,
			});
			const childFootprint = await ws.bb.sessions.footprint(outcome.thread!.id);
			expect(childFootprint.some((l) => l.facets?.inherited === true)).toBe(
				false,
			);
		} finally {
			await fake.restore();
			await ws.cleanup();
		}
	});

	test("尾部分叉但源足迹为空：走了 fork-session 也不写 inherited 读集", async () => {
		const ws = await makeTempWorkbench();
		const fake = await fakeClaude();
		try {
			const chat = new ChatThreads(ws.bb);
			const source = await chat.create();
			// 无工具调用的一轮：上下文可继承，读集无从继承
			await runAndSettle(chat, source.id, "只聊天");
			expect(await ws.bb.sessions.footprint(source.id)).toHaveLength(0);

			const messages = await chat.messages(source.id);
			const outcome = await chat.fork(source.id, messages.at(-1)!.id);
			expect(outcome.thread?.forkOf?.agentContextPlan?.mode).toBe(
				"fork-session",
			);
			await runAndSettle(chat, outcome.thread!.id, "child");

			// fork-session 这条路径确实走了……
			expect(await fake.argv()).toContainEqual(
				expect.arrayContaining(["--fork-session"]),
			);
			// ……但读集没有任何可继承的东西，所以一条 inherited 事件都不能有
			expect(
				await ws.bb.events.query({ type: "footprint.inherited" }),
			).toHaveLength(0);
			const child = await chat.get(outcome.thread!.id);
			expect(child.forkInheritance).toMatchObject({
				agentContextInherited: true,
				premiseInherited: false,
			});
			const childFootprint = await ws.bb.sessions.footprint(outcome.thread!.id);
			expect(childFootprint.some((l) => l.facets?.inherited === true)).toBe(
				false,
			);
		} finally {
			await fake.restore();
			await ws.cleanup();
		}
	});

	test("同一路径读两次：继承只取每路径最新一次观测，refs 只引最新那条足迹行", async () => {
		const ws = await makeTempWorkbench();
		const fake = await fakeClaude();
		try {
			await writeFile(join(ws.projectDir, "readme.md"), "v1\n");
			const chat = new ChatThreads(ws.bb);
			const source = await chat.create();
			await runAndSettle(chat, source.id, "read:readme.md");
			await writeFile(join(ws.projectDir, "readme.md"), "v2\n");
			await runAndSettle(chat, source.id, "read:readme.md");

			// 两轮各留一条足迹行，同一路径被读了两次
			const sourceFootprint = await ws.bb.sessions.footprint(source.id);
			const readingLines = sourceFootprint.filter((line) =>
				line.used.some((u) => u.path.endsWith("readme.md")),
			);
			expect(readingLines.length).toBeGreaterThanOrEqual(2);

			const messages = await chat.messages(source.id);
			const outcome = await chat.fork(source.id, messages.at(-1)!.id);
			expect(outcome.thread?.forkOf?.agentContextPlan?.mode).toBe(
				"fork-session",
			);
			await runAndSettle(chat, outcome.thread!.id, "child");

			const events = await ws.bb.events.query({ type: "footprint.inherited" });
			expect(events).toHaveLength(1);
			const payload = events[0]!.payload as {
				paths: string[];
				refs: string[];
				sourceFootprintSeq: number;
			};
			// 每路径一条，不是每次观测一条
			expect(payload.paths.filter((p) => p.endsWith("readme.md"))).toHaveLength(
				1,
			);
			expect(payload.refs).toHaveLength(payload.paths.length);

			const childFootprint = await ws.bb.sessions.footprint(outcome.thread!.id);
			const inheritedLine = childFootprint.find(
				(line) => line.facets?.inherited === true,
			);
			expect(inheritedLine).toBeDefined();
			expect(
				inheritedLine!.used.filter((u) => u.path.endsWith("readme.md")),
			).toHaveLength(1);
			// 继承的是事实引用，不是父线程的 spool 内容
			expect(inheritedLine!.used.every((u) => u.spool === undefined)).toBe(
				true,
			);
			expect(inheritedLine!.facets?.refs).toEqual(payload.refs);
		} finally {
			await fake.restore();
			await ws.cleanup();
		}
	});

	test("分叉的第二轮不再重复继承：inherited 事件恰好一条，--fork-session 只用一次", async () => {
		const ws = await makeTempWorkbench();
		const fake = await fakeClaude();
		try {
			await writeFile(join(ws.projectDir, "readme.md"), "facts\n");
			const chat = new ChatThreads(ws.bb);
			const source = await chat.create();
			await runAndSettle(chat, source.id, "read:readme.md");

			const messages = await chat.messages(source.id);
			const outcome = await chat.fork(source.id, messages.at(-1)!.id);
			const forkId = outcome.thread!.id;
			await runAndSettle(chat, forkId, "第一轮");
			await runAndSettle(chat, forkId, "第二轮");

			// 第二轮的分叉线程已有自己的可恢复会话 → 不再拼 --fork-session
			const forkRuns = (await fake.argv()).filter((a) =>
				a.includes("--fork-session"),
			);
			expect(forkRuns).toHaveLength(1);
			// 继承是一次性事实，不随每轮回填
			expect(
				await ws.bb.events.query({ type: "footprint.inherited" }),
			).toHaveLength(1);
			const inheritedLines = (await ws.bb.sessions.footprint(forkId)).filter(
				(line) => line.facets?.inherited === true,
			);
			expect(inheritedLines).toHaveLength(1);
			// 继承观测也只落一次
			expect(
				await ws.bb.events.query({ type: "thread.inheritance_observed" }),
			).toHaveLength(1);
		} finally {
			await fake.restore();
			await ws.cleanup();
		}
	});

	test("HTTP provider：上下文靠历史重发算继承，读集恒不继承", async () => {
		const ws = await makeTempWorkbench();
		const originalFetch = globalThis.fetch;
		try {
			await ws.bb.config.save({
				...workbenchConfigSchema.parse({}),
				chat: { provider: "openai-chat", apiKey: "test-key" },
			});
			globalThis.fetch = (async () =>
				new Response(
					`data: ${JSON.stringify({
						choices: [{ delta: { content: "ok" } }],
					})}\n\ndata: [DONE]\n\n`,
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				)) as unknown as typeof fetch;

			const chat = new ChatThreads(ws.bb);
			const source = await chat.create();
			await chat.run(source.id, "问一个", () => {});
			const messages = await chat.messages(source.id);
			const outcome = await chat.fork(source.id, messages.at(-1)!.id);
			expect(outcome.ok).toBe(true);
			// provider 不是 claude → 没有 fork-session 计划可言
			expect(outcome.thread?.forkOf?.agentContextPlan).toBeUndefined();
			await chat.run(outcome.thread!.id, "child", () => {});

			// HTTP 没有工具通道，足迹恒为空集：一条 inherited 事件都不能有
			expect(
				await ws.bb.events.query({ type: "footprint.inherited" }),
			).toHaveLength(0);
			const child = await chat.get(outcome.thread!.id);
			expect(child.forkInheritance).toMatchObject({
				agentContextInherited: true,
				premiseInherited: false,
				provider: "openai-chat",
			});
			const observed = await ws.bb.events.query({
				type: "thread.inheritance_observed",
			});
			expect(observed).toHaveLength(1);
			expect(observed[0]!.payload).toMatchObject({
				mode: "http-history",
				agentContextInherited: true,
				premiseInherited: false,
			});
			// 观测事件是观测，不带裁决字段（types/event.ts 的信任边界）
			expect(JSON.stringify(observed[0]!.payload)).not.toContain('"status"');
		} finally {
			globalThis.fetch = originalFetch;
			await ws.cleanup();
		}
	});
});
