import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathExists } from "../fs/atomic";
import { hashFile } from "../hash";
import { chatContext } from "../test/chat-context";
import { makeTempWorkbench } from "../test/fixtures";
import { workbenchConfigSchema } from "../types/config";
import { ackNotices, drainNotices } from "./notice-queue";
import { UNNAMED_TITLE } from "./promote";
import { ChatThreads, type StoredMessage } from "./threads";

function msg(role: "user" | "assistant", text: string): StoredMessage {
	return {
		id: `m-${Math.random().toString(36).slice(2, 8)}`,
		role,
		text,
		at: new Date().toISOString(),
	};
}

function threadDir(workbenchRoot: string, id: string): string {
	// 与 ChatThreads.dir 一致的布局：.workbench/threads/<id>/
	return join(workbenchRoot, "threads", id);
}

async function appendMessages(
	workbenchRoot: string,
	id: string,
	messages: StoredMessage[],
): Promise<void> {
	for (const m of messages) {
		await appendFile(
			join(threadDir(workbenchRoot, id), "messages.jsonl"),
			`${JSON.stringify(m)}\n`,
			"utf8",
		);
	}
}

async function readTranscript(
	workbenchRoot: string,
	id: string,
): Promise<string> {
	return readFile(join(threadDir(workbenchRoot, id), "messages.jsonl"), "utf8");
}

type NoticeInternals = {
	drainNotices(id: string): Promise<{
		entries: Array<{ id: string; notice: string; at: string }>;
	}>;
	ackNotices(id: string, ids: string[]): Promise<boolean>;
};

type ThreadEventInternals = {
	appendThreadEvent(
		type: string,
		threadId: string,
		payload: Record<string, unknown>,
	): Promise<{ payload?: unknown }>;
};

function noticeInternals(chat: ChatThreads): NoticeInternals {
	const context = chatContext(chat);
	return {
		drainNotices: (id) => drainNotices(context, id),
		ackNotices: (id, ids) => ackNotices(context, id, ids),
	};
}

function threadEventInternals(chat: ChatThreads): ThreadEventInternals {
	return chatContext(chat).store;
}

function noticesFile(workbenchRoot: string, id: string): string {
	return join(threadDir(workbenchRoot, id), "notices.jsonl");
}

describe("ChatThreads 晋升（TF-0092）", () => {
	test("新对话默认无名；手动晋升一次手势命名，消息零变化", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			expect(thread.title).toBe(UNNAMED_TITLE);

			const messages = [
				msg("user", "调研上下文回退方案"),
				msg("assistant", "好"),
			];
			await appendMessages(workbenchRoot, thread.id, messages);
			const before = await readTranscript(workbenchRoot, thread.id);

			const promoted = await chat.promote(thread.id);
			expect(promoted.title).toBe("调研上下文回退方案");
			expect(promoted.promotion?.title).toBe("调研上下文回退方案");
			expect(promoted.promotion?.signals).toEqual([]);

			// 晋升后对话本身零变化：messages.jsonl 一个字节不动
			const after = await readTranscript(workbenchRoot, thread.id);
			expect(after).toBe(before);
		} finally {
			await cleanup();
		}
	});

	test("已命名的对话晋升是空操作；空对话无可派生名字", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);

			// 空对话：没有第一条用户消息，保持无名
			const empty = await chat.create();
			const emptyResult = await chat.promote(empty.id);
			expect(emptyResult.title).toBe(UNNAMED_TITLE);

			// 已命名：用户改过的标题不被覆盖
			const named = await chat.create();
			await appendMessages(workbenchRoot, named.id, [msg("user", "原始话题")]);
			await chat.update(named.id, { title: "我自己的名字" });
			const result = await chat.promote(named.id);
			expect(result.title).toBe("我自己的名字");
		} finally {
			await cleanup();
		}
	});

	test("reload 记录分叉计数（二次分叉触发信号的输入）", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			const user = msg("user", "第一问");
			const assistant = msg("assistant", "第一答");
			await appendMessages(workbenchRoot, thread.id, [user, assistant]);

			const outcome = await chat.reload(thread.id);
			expect(outcome.ok).toBe(true);

			const meta = await chat.get(thread.id);
			expect(meta.forks?.[user.id]).toBe(1);
		} finally {
			await cleanup();
		}
	});
});

describe("ChatThreads 追溯式分叉（TF-0093）", () => {
	test("锚点处分叉：新线程继承前缀（含锚点），原线程逐字节不变，继承声明随响应返回", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			const m1 = msg("user", "调研上下文回退方案");
			const m2 = msg("assistant", "方案 A 是…");
			const m3 = msg("user", "对比方案 B");
			const m4 = msg("assistant", "方案 B 的差异在…");
			await appendMessages(workbenchRoot, thread.id, [m1, m2, m3, m4]);
			const before = await readTranscript(workbenchRoot, thread.id);

			const outcome = await chat.fork(thread.id, m3.id);
			expect(outcome.ok).toBe(true);
			const forkThread = outcome.thread!;
			const declaration = outcome.declaration!;

			// 新线程继承锚点（含）之前的前缀：m1 m2 m3
			const forkMessages = await chat.messages(forkThread.id);
			expect(forkMessages.map((m) => m.id)).toEqual([m1.id, m2.id, m3.id]);

			// 原线程完全不受影响：messages.jsonl 逐字节一致
			const after = await readTranscript(workbenchRoot, thread.id);
			expect(after).toBe(before);

			// 继承声明：继承几条、锚点是谁、其余全部从新开始
			expect(declaration.inheritedMessages).toBe(3);
			expect(declaration.anchor).toMatchObject({ id: m3.id, role: "user" });
			expect(declaration.freshAgentSession).toBe(true);
			expect(declaration.freshPromotion).toBe(true);

			// 血统记录进 meta，线程列表可见（兄弟条目）
			expect(forkThread.forkOf).toMatchObject({
				sourceThreadId: thread.id,
				anchorMessageId: m3.id,
				inheritedMessages: 3,
			});
			const list = await chat.list();
			expect(list.map((t) => t.id).sort()).toEqual(
				[thread.id, forkThread.id].sort(),
			);

			// 零仪式：标题从继承前缀确定性推导（与晋升同规则），不要求用户输入
			expect(forkThread.title).toBe("调研上下文回退方案");

			// 源线程的分叉计数 +1（feeds TF-0092 second-fork 信号）
			const sourceMeta = await chat.get(thread.id);
			expect(sourceMeta.forks?.[m3.id]).toBe(1);
		} finally {
			await cleanup();
		}
	});

	test("同一条消息分叉两次计数到 2（二次分叉信号的输入）；未知锚点拒绝", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			const user = msg("user", "第一问");
			const assistant = msg("assistant", "第一答");
			await appendMessages(workbenchRoot, thread.id, [user, assistant]);

			expect((await chat.fork(thread.id, user.id)).ok).toBe(true);
			expect((await chat.fork(thread.id, user.id)).ok).toBe(true);
			const meta = await chat.get(thread.id);
			expect(meta.forks?.[user.id]).toBe(2);

			const missing = await chat.fork(thread.id, "m-nope");
			expect(missing.ok).toBe(false);
			expect(missing.reason).toBe("找不到锚点消息");
		} finally {
			await cleanup();
		}
	});

	test("Claude 尾部分叉只在真实 --fork-session 后记录继承足迹", async () => {
		const ws = await makeTempWorkbench();
		const fakeDir = await mkdtemp(join(tmpdir(), "workbench-fork-agent-"));
		const previousCommand = process.env.WORKBENCH_CHAT_COMMAND;
		try {
			await writeFile(
				join(ws.projectDir, "readme.md"),
				"source facts\n",
				"utf8",
			);
			const fake = String.raw`
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(1);
appendFileSync(join(__dirname, "argv.log"), JSON.stringify(args) + "\n");
const line = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const session = args.includes("--fork-session") ? "child-session" : (args[args.indexOf("--session-id") + 1] || "parent-session");
line({ type: "system", subtype: "init", session_id: session });
let buffer = "";
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
    if (prompt === "source") {
      line({ type: "assistant", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: join(process.cwd(), "readme.md") } }] } });
      line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "source facts" }] } });
    }
    line({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
    line({ type: "result", subtype: "success", result: "ok" });
    setTimeout(() => process.exit(0), 5);
    break;
  }
});

`;
			await writeFile(join(fakeDir, "agent.js"), fake, "utf8");
			process.env.WORKBENCH_CHAT_COMMAND = `bun ${join(fakeDir, "agent.js")}`;
			const chat = new ChatThreads(ws.bb);
			const source = await chat.create();
			await chat.run(source.id, "source", () => {});
			for (let attempt = 0; attempt < 40; attempt += 1) {
				if (!chatContext(chat).live.has(source.id)) {
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			const sourceMessages = await chat.messages(source.id);
			const outcome = await chat.fork(source.id, sourceMessages.at(-1)!.id);
			expect(outcome.ok).toBe(true);
			expect(outcome.thread?.forkOf?.agentContextPlan?.mode).toBe(
				"fork-session",
			);
			await chat.run(outcome.thread!.id, "child", () => {});

			const argv = (await readFile(join(fakeDir, "argv.log"), "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[]);
			expect(argv[1]).toContain("--fork-session");
			expect(argv[1]).toContain(source.id);
			const child = await chat.get(outcome.thread!.id);
			expect(child.forkInheritance).toMatchObject({
				agentContextInherited: true,
				premiseInherited: true,
			});
			expect(
				await ws.bb.events.query({ type: "footprint.inherited" }),
			).toHaveLength(1);
			const childFootprint = await ws.bb.sessions.footprint(outcome.thread!.id);
			expect(
				childFootprint.some((line) => line.facets?.inherited === true),
			).toBe(true);
			expect(childFootprint.at(-1)?.used[0]?.spool).toBeUndefined();
		} finally {
			if (previousCommand === undefined) {
				delete process.env.WORKBENCH_CHAT_COMMAND;
			} else {
				process.env.WORKBENCH_CHAT_COMMAND = previousCommand;
			}
			await rm(fakeDir, { recursive: true, force: true });
			await ws.cleanup();
		}
	});
});

describe("自动扇出变体（TF-0094）", () => {
	test("fanout=2：主回答照常流式落盘，shadow 变体作为备选挂在同一条消息上", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		const originalFetch = globalThis.fetch;
		try {
			await bb.config.save({
				...workbenchConfigSchema.parse({}),
				chat: { provider: "openai-chat", apiKey: "test-key", fanout: 2 },
			});
			let calls = 0;
			globalThis.fetch = (async () => {
				calls++;
				const content = calls === 1 ? "主回答" : "shadow 回答";
				const body = `data: ${JSON.stringify({
					choices: [{ delta: { content } }],
				})}\n\ndata: [DONE]\n\n`;
				return new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}) as unknown as typeof fetch;

			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			const events: Record<string, unknown>[] = [];
			await chat.run(thread.id, "问一个", (event) => events.push(event));

			// 主回答照常：user + assistant(无 variants 字段或为空数组时不出现在 JSON)
			const messages = await chat.messages(thread.id);
			expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
			expect(messages[1]!.text).toBe("主回答");
			// shadow 变体作为备选挂上（不含主回答本身）
			expect(messages[1]!.variants).toEqual(["shadow 回答"]);
			// done 事件携带的 message 同样带备选（UI 的数据源）
			const done = events.find((e) => e.type === "done") as {
				message?: StoredMessage;
			};
			expect(done.message?.variants).toEqual(["shadow 回答"]);
			// 两个请求都发出（主 + shadow）
			expect(calls).toBe(2);
		} finally {
			globalThis.fetch = originalFetch;
			await cleanup();
		}
	});

	test("fanout=1（默认）：单请求，无备选字段", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		const originalFetch = globalThis.fetch;
		try {
			await bb.config.save({
				...workbenchConfigSchema.parse({}),
				chat: { provider: "openai-chat", apiKey: "test-key" },
			});
			let calls = 0;
			globalThis.fetch = (async () => {
				calls++;
				const body = `data: ${JSON.stringify({
					choices: [{ delta: { content: "唯一回答" } }],
				})}\n\ndata: [DONE]\n\n`;
				return new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}) as unknown as typeof fetch;

			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			await chat.run(thread.id, "问一个", () => {});
			const messages = await chat.messages(thread.id);
			expect(messages[1]!.text).toBe("唯一回答");
			expect(messages[1]!.variants).toBeUndefined();
			expect(calls).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
			await cleanup();
		}
	});
});

describe("ChatThreads 恢复笔记（TF-0097）", () => {
	test("leave：从既有消息推导笔记并写进 meta", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			await appendMessages(workbenchRoot, thread.id, [
				msg("user", "调研上下文回退方案"),
				msg("assistant", "可以分两步：\n1. 先写纯函数\n2. 再接线"),
			]);

			const note = await chat.leave(thread.id);
			expect(note).not.toBeNull();
			expect(note!.beats.length).toBeGreaterThanOrEqual(2);
			expect(note!.beats[0]!.kind).toBe("doing");
			expect(note!.confirmedAt).toBeUndefined();

			const meta = await chat.get(thread.id);
			expect(meta.resumeNote).toEqual(note!);
		} finally {
			await cleanup();
		}
	});

	test("leave 空对话：返回 null，不写笔记", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			const note = await chat.leave(thread.id);
			expect(note).toBeNull();
			const meta = await chat.get(thread.id);
			expect(meta.resumeNote).toBeUndefined();
		} finally {
			await cleanup();
		}
	});

	test("setResumeNote 确认：置 confirmedAt", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			await appendMessages(workbenchRoot, thread.id, [
				msg("user", "做恢复笔记"),
				msg("assistant", "好"),
			]);
			await chat.leave(thread.id);

			const confirmed = await chat.setResumeNote(thread.id, {
				confirmed: true,
			});
			expect(confirmed?.confirmedAt).toBeDefined();

			const meta = await chat.get(thread.id);
			expect(meta.resumeNote?.confirmedAt).toBeDefined();
		} finally {
			await cleanup();
		}
	});

	test("setResumeNote 编辑：替换 beats", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			await appendMessages(workbenchRoot, thread.id, [
				msg("user", "做恢复笔记"),
				msg("assistant", "好"),
			]);
			await chat.leave(thread.id);

			const edited = await chat.setResumeNote(thread.id, {
				beats: [{ kind: "doing", text: "用户改写的节拍" }],
			});
			expect(edited?.beats).toHaveLength(1);
			expect(edited?.beats[0]?.text).toBe("用户改写的节拍");
		} finally {
			await cleanup();
		}
	});

	test("setResumeNote 无笔记时返回 undefined", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			const result = await chat.setResumeNote(thread.id, { confirmed: true });
			expect(result).toBeUndefined();
		} finally {
			await cleanup();
		}
	});
});

describe("ChatThreads 前提通知队列（R2）", () => {
	test("Claude 只在完整 provider 轮次后确认通知，并保持 NDJSON 分帧", async () => {
		const ws = await makeTempWorkbench();
		const fakeDir = await mkdtemp(join(tmpdir(), "workbench-notice-agent-"));
		const previousCommand = process.env.WORKBENCH_CHAT_COMMAND;
		try {
			const fake = String.raw`
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const line = (value) => process.stdout.write(JSON.stringify(value) + "\n");
line({ type: "system", subtype: "init", session_id: "notice-session" });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const raw = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!raw) continue;
    appendFileSync(join(__dirname, "prompts.log"), raw + "\n");
    const content = String(JSON.parse(raw)?.message?.content || "");
    const text = content.includes("first") ? "first ok" : "second ok";
    line({ type: "assistant", message: { content: [{ type: "text", text }] } });
    line({ type: "result", subtype: "success", result: text });
    if (content.includes("second")) setTimeout(() => process.exit(0), 10);
  }
});
`;
			await writeFile(join(fakeDir, "agent.js"), fake, "utf8");
			process.env.WORKBENCH_CHAT_COMMAND = `bun ${join(fakeDir, "agent.js")}`;
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			await chat.run(thread.id, "first", () => {});
			await chat.notifySession(thread.id, "前提已经变化");
			await chat.run(thread.id, "second", () => {});

			const prompts = (await readFile(join(fakeDir, "prompts.log"), "utf8"))
				.trim()
				.split("\n")
				.map((raw) => JSON.parse(raw) as { message?: { content?: string } });
			expect(prompts).toHaveLength(2);
			expect(prompts[1]?.message?.content).toContain("前提已经变化");
			expect(await pathExists(noticesFile(ws.workbenchRoot, thread.id))).toBe(
				false,
			);
			expect(
				await ws.bb.events.query({ type: "premise_notice_delivered" }),
			).toHaveLength(1);
		} finally {
			if (previousCommand === undefined) {
				delete process.env.WORKBENCH_CHAT_COMMAND;
			} else {
				process.env.WORKBENCH_CHAT_COMMAND = previousCommand;
			}
			await rm(fakeDir, { recursive: true, force: true });
			await ws.cleanup();
		}
	});

	test("Claude 没有 assistant/result 时保留通知，下一次仍可重试", async () => {
		const ws = await makeTempWorkbench();
		const fakeDir = await mkdtemp(join(tmpdir(), "workbench-notice-fail-"));
		const previousCommand = process.env.WORKBENCH_CHAT_COMMAND;
		try {
			const fake = String.raw`
const line = (value) => process.stdout.write(JSON.stringify(value) + "\n");
line({ type: "system", subtype: "init", session_id: "failed-notice-session" });
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => setTimeout(() => process.exit(0), 5));
`;
			await writeFile(join(fakeDir, "agent.js"), fake, "utf8");
			process.env.WORKBENCH_CHAT_COMMAND = `bun ${join(fakeDir, "agent.js")}`;
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			await chat.notifySession(thread.id, "失败后不可丢");
			await chat.run(thread.id, "try", () => {});

			expect(await pathExists(noticesFile(ws.workbenchRoot, thread.id))).toBe(
				true,
			);
			expect(
				(await noticeInternals(chat).drainNotices(thread.id)).entries.map(
					(entry) => entry.notice,
				),
			).toEqual(["失败后不可丢"]);
			expect(
				await ws.bb.events.query({ type: "premise_notice_delivered" }),
			).toHaveLength(0);
		} finally {
			if (previousCommand === undefined) {
				delete process.env.WORKBENCH_CHAT_COMMAND;
			} else {
				process.env.WORKBENCH_CHAT_COMMAND = previousCommand;
			}
			await rm(fakeDir, { recursive: true, force: true });
			await ws.cleanup();
		}
	});

	test("Claude 只有 tool-use 后崩溃时不提前确认通知", async () => {
		const ws = await makeTempWorkbench();
		const fakeDir = await mkdtemp(
			join(tmpdir(), "workbench-notice-tool-fail-"),
		);
		const previousCommand = process.env.WORKBENCH_CHAT_COMMAND;
		try {
			const fake = String.raw`
const line = (value) => process.stdout.write(JSON.stringify(value) + "\n");
line({ type: "system", subtype: "init", session_id: "tool-fail-session" });
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (!chunk.trim()) return;
  line({ type: "assistant", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } }] } });
  setTimeout(() => process.exit(1), 5);
});
`;
			await writeFile(join(fakeDir, "agent.js"), fake, "utf8");
			process.env.WORKBENCH_CHAT_COMMAND = `bun ${join(fakeDir, "agent.js")}`;
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			await chat.notifySession(thread.id, "tool-use 后仍需重试");
			await chat.run(thread.id, "try", () => {});

			expect(await pathExists(noticesFile(ws.workbenchRoot, thread.id))).toBe(
				true,
			);
			expect(
				await ws.bb.events.query({ type: "premise_notice_delivered" }),
			).toHaveLength(0);
		} finally {
			if (previousCommand === undefined) {
				delete process.env.WORKBENCH_CHAT_COMMAND;
			} else {
				process.env.WORKBENCH_CHAT_COMMAND = previousCommand;
			}
			await rm(fakeDir, { recursive: true, force: true });
			await ws.cleanup();
		}
	});

	test("HTTP provider 只有完整成功响应才确认通知", async () => {
		const ws = await makeTempWorkbench();
		const originalFetch = globalThis.fetch;
		try {
			await ws.bb.config.save({
				...workbenchConfigSchema.parse({}),
				chat: { provider: "openai-chat", apiKey: "test-key" },
			});
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			await chat.notifySession(thread.id, "HTTP 前提变化");

			globalThis.fetch = (async () =>
				new Response("bad gateway", {
					status: 502,
				})) as unknown as typeof fetch;
			await chat.run(thread.id, "failed status", () => {});
			expect(await pathExists(noticesFile(ws.workbenchRoot, thread.id))).toBe(
				true,
			);

			globalThis.fetch = (async () => {
				throw new Error("network reset");
			}) as unknown as typeof fetch;
			await chat.run(thread.id, "failed network", () => {});
			expect(await pathExists(noticesFile(ws.workbenchRoot, thread.id))).toBe(
				true,
			);

			// A 2xx body that ends without an SSE frame delimiter is partial, not
			// evidence that the provider accepted the turn.
			globalThis.fetch = (async () =>
				new Response(
					`data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n`,
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				)) as unknown as typeof fetch;
			await chat.run(thread.id, "truncated", () => {});
			expect(await pathExists(noticesFile(ws.workbenchRoot, thread.id))).toBe(
				true,
			);

			// Explicit provider error events are failures even when a proxy appends
			// the normal [DONE] sentinel afterwards.
			globalThis.fetch = (async () =>
				new Response(
					`data: ${JSON.stringify({ error: { message: "stream failed" } })}\n\ndata: [DONE]\n\n`,
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				)) as unknown as typeof fetch;
			await chat.run(thread.id, "stream error", () => {});
			expect(await pathExists(noticesFile(ws.workbenchRoot, thread.id))).toBe(
				true,
			);

			globalThis.fetch = (async () =>
				new Response(
					`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`,
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				)) as unknown as typeof fetch;
			await chat.run(thread.id, "successful retry", () => {});
			expect(await pathExists(noticesFile(ws.workbenchRoot, thread.id))).toBe(
				false,
			);
		} finally {
			globalThis.fetch = originalFetch;
			await ws.cleanup();
		}
	});

	test("通知先持久化；drain 不删除，ack 只删除已发送批次", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			expect(await chat.notifySession(thread.id, "文件已变化")).toBe("queued");

			const file = noticesFile(workbenchRoot, thread.id);
			const drained = await noticeInternals(chat).drainNotices(thread.id);
			expect(drained.entries).toHaveLength(1);
			expect(drained.entries[0]?.notice).toBe("文件已变化");
			expect(await pathExists(file)).toBe(true);

			await noticeInternals(chat).ackNotices(thread.id, [
				drained.entries[0]!.id,
			]);
			expect(await pathExists(file)).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("相同通知只入队一次，并可用稳定 id 升级通知正文", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			await chat.notifySession(thread.id, "简略前提");
			await chat.notifySession(thread.id, "简略前提");
			const first = await noticeInternals(chat).drainNotices(thread.id);
			expect(first.entries).toHaveLength(1);

			await chat.notifySession(thread.id, "完整前提证据", first.entries[0]!.id);
			const upgraded = await noticeInternals(chat).drainNotices(thread.id);
			expect(upgraded.entries).toHaveLength(1);
			expect(upgraded.entries[0]?.notice).toBe("完整前提证据");
			expect(upgraded.entries[0]?.id).toBe(first.entries[0]?.id);
			expect(await pathExists(noticesFile(workbenchRoot, thread.id))).toBe(
				true,
			);
		} finally {
			await cleanup();
		}
	});

	test("provider 通知预算只确认实际进入本轮的条目", async () => {
		const ws = await makeTempWorkbench();
		const originalFetch = globalThis.fetch;
		try {
			await ws.bb.config.save({
				...workbenchConfigSchema.parse({}),
				chat: {
					provider: "openai-chat",
					apiKey: "test-key",
					noticeTokenBudget: 5,
				},
			});
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			await chat.notifySession(thread.id, "短通知");
			await chat.notifySession(
				thread.id,
				"这个通知太长，不能进入五个 token 的预算",
			);
			let requestBody: { messages?: Array<{ content?: string }> } | undefined;
			globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}) as unknown as typeof fetch;

			await chat.run(thread.id, "ask", () => {});
			const prompt = requestBody?.messages?.at(-1)?.content ?? "";
			expect(prompt).toContain("短通知");
			expect(prompt).not.toContain("这个通知太长");
			expect(
				(await noticeInternals(chat).drainNotices(thread.id)).entries.map(
					(entry) => entry.notice,
				),
			).toEqual(["这个通知太长，不能进入五个 token 的预算"]);
		} finally {
			globalThis.fetch = originalFetch;
			await ws.cleanup();
		}
	});

	test("ack 期间追加的新通知不会被误删", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			await chat.notifySession(thread.id, "旧通知 A");
			await chat.notifySession(thread.id, "旧通知 B");
			const batch = await noticeInternals(chat).drainNotices(thread.id);
			await chat.notifySession(thread.id, "并发追加 C");
			await noticeInternals(chat).ackNotices(
				thread.id,
				batch.entries.map((entry) => entry.id),
			);

			const remaining = await noticeInternals(chat).drainNotices(thread.id);
			expect(remaining.entries.map((entry) => entry.notice)).toEqual([
				"并发追加 C",
			]);
		} finally {
			await cleanup();
		}
	});

	test("发送失败时不 ack，下一轮仍能读到通知", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			await chat.notifySession(thread.id, "不要丢失");
			const batch = await noticeInternals(chat).drainNotices(thread.id);
			// 模拟 provider 在发送前崩溃：故意不调用 ackNotices。
			expect(batch.entries[0]?.notice).toBe("不要丢失");
			expect(
				(await noticeInternals(chat).drainNotices(thread.id)).entries,
			).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	test("旧的纯文本通知仍可迁移读取并 ack", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			const file = noticesFile(workbenchRoot, thread.id);
			await writeFile(file, "legacy notice\n", "utf8");
			const batch = await noticeInternals(chat).drainNotices(thread.id);
			expect(batch.entries).toHaveLength(1);
			expect(batch.entries[0]?.notice).toBe("legacy notice");
			await noticeInternals(chat).ackNotices(thread.id, [batch.entries[0]!.id]);
			expect(await pathExists(file)).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("未知形状的通知行也保留为可重试的原文", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const thread = await chat.create();
			const file = noticesFile(workbenchRoot, thread.id);
			await writeFile(file, '{"futureField":"keep me"}\n', "utf8");
			const batch = await noticeInternals(chat).drainNotices(thread.id);
			expect(batch.entries).toHaveLength(1);
			expect(batch.entries[0]?.notice).toBe('{"futureField":"keep me"}');
			await noticeInternals(chat).ackNotices(thread.id, [batch.entries[0]!.id]);
			expect(await pathExists(file)).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("非聊天写者没有 transcript 时不伪造已投递", async () => {
		const { workbenchRoot, bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			await bb.sessions.register("batch-agent", "agent", "批处理 agent");
			expect(await chat.notifySession("batch-agent", "应保持待投递")).toBe(
				false,
			);
			expect(
				await pathExists(
					join(workbenchRoot, "threads", "batch-agent", "notices.jsonl"),
				),
			).toBe(false);
		} finally {
			await cleanup();
		}
	});
});

describe("ChatThreads 生命周期事件", () => {
	test("目标 threadId 不会被调用方 payload 覆盖", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(bb);
			const event = await threadEventInternals(chat).appendThreadEvent(
				"thread.restored",
				"thread-target",
				{ threadId: "thread-injected" },
			);

			expect(event.payload).toMatchObject({ threadId: "thread-target" });
		} finally {
			await cleanup();
		}
	});
});

describe("通知通道语义（TF-0142：live / idle / 多通知 / turn-in-flight）", () => {
	async function withFakeAgent(
		script: string,
		prefix: string,
		run: (fakeDir: string) => Promise<void>,
	): Promise<void> {
		const fakeDir = await mkdtemp(join(tmpdir(), prefix));
		const previousCommand = process.env.WORKBENCH_CHAT_COMMAND;
		try {
			await writeFile(join(fakeDir, "agent.js"), script, "utf8");
			process.env.WORKBENCH_CHAT_COMMAND = `bun ${join(fakeDir, "agent.js")}`;
			await run(fakeDir);
		} finally {
			if (previousCommand === undefined) {
				delete process.env.WORKBENCH_CHAT_COMMAND;
			} else {
				process.env.WORKBENCH_CHAT_COMMAND = previousCommand;
			}
			await rm(fakeDir, { recursive: true, force: true });
		}
	}

	async function readPrompts(
		fakeDir: string,
	): Promise<Array<{ message?: { content?: string } }>> {
		const raw = await readFile(join(fakeDir, "prompts.log"), "utf8");
		if (!raw.trim()) {
			return [];
		}
		return raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { message?: { content?: string } });
	}

	test("turn in flight：notifySession 只排队，不写入 live 通道", async () => {
		const ws = await makeTempWorkbench();
		try {
			const fake = String.raw`
const { appendFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const line = (value) => process.stdout.write(JSON.stringify(value) + "\n");
line({ type: "system", subtype: "init", session_id: "inflight-session" });
let buffer = "";
let turns = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const raw = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!raw) continue;
    appendFileSync(join(__dirname, "prompts.log"), raw + "\n");
    turns += 1;
    if (turns === 1) {
      const wait = () => {
        if (existsSync(join(__dirname, "release.flag"))) {
          line({ type: "assistant", message: { content: [{ type: "text", text: "first ok" }] } });
          line({ type: "result", subtype: "success", result: "first ok" });
        } else {
          setTimeout(wait, 5);
        }
      };
      wait();
    } else {
      line({ type: "assistant", message: { content: [{ type: "text", text: "second ok" }] } });
      line({ type: "result", subtype: "success", result: "second ok" });
      setTimeout(() => process.exit(0), 10);
    }
  }
});
`;
			await withFakeAgent(
				fake,
				"workbench-notice-inflight-",
				async (fakeDir) => {
					const chat = new ChatThreads(ws.bb);
					const thread = await chat.create();
					const firstTurn = chat.run(thread.id, "first", () => {});
					for (;;) {
						const prompts = await readPrompts(fakeDir).catch(() => []);
						if (prompts.length > 0) {
							break;
						}
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
					// 第一帧已被 provider 消费 ⇒ 本轮的 drainNotices 早已发生
					expect(await readPrompts(fakeDir)).toHaveLength(1);

					expect(await chat.notifySession(thread.id, "轮内通知")).toBe(
						"queued",
					);
					// 通道 live，但通知不直接写入 stdin——它在下一轮折叠
					expect(await readPrompts(fakeDir)).toHaveLength(1);
					const queued = await ws.bb.events.query({
						type: "premise_notice_queued",
					});
					expect(queued).toHaveLength(1);
					expect(queued[0]?.payload).toMatchObject({
						writer: thread.id,
						reason: "turn-in-flight",
					});

					await writeFile(join(fakeDir, "release.flag"), "1", "utf8");
					await firstTurn;
					// 第一轮结束也不注入：通知只走「排队 → 下一轮折叠」一条路
					expect(await readPrompts(fakeDir)).toHaveLength(1);

					await chat.run(thread.id, "second", () => {});
					const prompts = await readPrompts(fakeDir);
					expect(prompts).toHaveLength(2);
					expect(prompts[1]?.message?.content).toContain("轮内通知");
					expect(prompts[1]?.message?.content).toContain("second");
					expect(
						await pathExists(noticesFile(ws.workbenchRoot, thread.id)),
					).toBe(false);
				},
			);
		} finally {
			await ws.cleanup();
		}
	});

	test("live 空闲：多条 preceding notices 折叠进同一个用户轮，不提前结束", async () => {
		const ws = await makeTempWorkbench();
		try {
			const fake = String.raw`
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const line = (value) => process.stdout.write(JSON.stringify(value) + "\n");
line({ type: "system", subtype: "init", session_id: "live-idle-session" });
let buffer = "";
let turns = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const raw = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!raw) continue;
    appendFileSync(join(__dirname, "prompts.log"), raw + "\n");
    turns += 1;
    line({ type: "assistant", message: { content: [{ type: "text", text: "ok " + turns }] } });
    line({ type: "result", subtype: "success", result: "ok " + turns });
    if (turns >= 2) setTimeout(() => process.exit(0), 10);
  }
});
`;
			await withFakeAgent(
				fake,
				"workbench-notice-live-idle-",
				async (fakeDir) => {
					const chat = new ChatThreads(ws.bb);
					const thread = await chat.create();
					await chat.run(thread.id, "first", () => {});
					expect(await readPrompts(fakeDir)).toHaveLength(1);

					// 通道 live 且空闲：通知仍只排队，不写入 stdin
					expect(await chat.notifySession(thread.id, "通知 A")).toBe("queued");
					expect(await chat.notifySession(thread.id, "通知 B")).toBe("queued");
					expect(await readPrompts(fakeDir)).toHaveLength(1);
					const queued = await ws.bb.events.query({
						type: "premise_notice_queued",
					});
					expect(
						queued.map(
							(event) => (event.payload as { reason?: string }).reason,
						),
					).toEqual(["next-user-turn", "next-user-turn"]);

					const emitted: Array<Record<string, unknown>> = [];
					await chat.run(thread.id, "second", (event) => emitted.push(event));
					const prompts = await readPrompts(fakeDir);
					// 两条通知与用户请求在同一个 stdin 帧：一帧 ⇒ 一个 provider 轮次
					expect(prompts).toHaveLength(2);
					const second = prompts[1]?.message?.content ?? "";
					expect(second).toContain("通知 A");
					expect(second).toContain("通知 B");
					expect(second).toContain("second");
					// 用户轮只在真实 result 之后结束一次
					expect(emitted.filter((event) => event.type === "done")).toHaveLength(
						1,
					);
					const noticeDeliveredAt = emitted.findIndex(
						(event) => event.type === "notice_delivered",
					);
					const doneAt = emitted.findIndex((event) => event.type === "done");
					expect(noticeDeliveredAt).toBeGreaterThanOrEqual(0);
					expect(noticeDeliveredAt).toBeLessThan(doneAt);

					const delivered = await ws.bb.events.query({
						type: "premise_notice_delivered",
					});
					expect(delivered).toHaveLength(1);
					expect(delivered[0]?.payload).toMatchObject({
						writer: thread.id,
						count: 2,
						readObservability: "footprint",
					});
					expect(
						await pathExists(noticesFile(ws.workbenchRoot, thread.id)),
					).toBe(false);
				},
			);
		} finally {
			await ws.cleanup();
		}
	});

	test("无 live 通道（idle）：通知先落盘，不唤醒任何 provider", async () => {
		const ws = await makeTempWorkbench();
		try {
			const fake = String.raw`
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const line = (value) => process.stdout.write(JSON.stringify(value) + "\n");
line({ type: "system", subtype: "init", session_id: "cold-session" });
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const raw = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!raw) continue;
    appendFileSync(join(__dirname, "prompts.log"), raw + "\n");
    line({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
    line({ type: "result", subtype: "success", result: "done" });
    setTimeout(() => process.exit(0), 10);
  }
});
`;
			await withFakeAgent(fake, "workbench-notice-cold-", async (fakeDir) => {
				const chat = new ChatThreads(ws.bb);
				const thread = await chat.create();
				expect(await chat.notifySession(thread.id, "冷通知")).toBe("queued");
				expect(await pathExists(noticesFile(ws.workbenchRoot, thread.id))).toBe(
					true,
				);
				// 没有任何 provider 被唤醒
				expect(await pathExists(join(fakeDir, "prompts.log"))).toBe(false);
				const queued = await ws.bb.events.query({
					type: "premise_notice_queued",
				});
				expect(queued[0]?.payload).toMatchObject({
					reason: "next-user-turn",
				});

				await chat.run(thread.id, "first", () => {});
				const prompts = await readPrompts(fakeDir);
				expect(prompts).toHaveLength(1);
				expect(prompts[0]?.message?.content).toContain("冷通知");
				expect(prompts[0]?.message?.content).toContain("first");
				const delivered = await ws.bb.events.query({
					type: "premise_notice_delivered",
				});
				expect(delivered).toHaveLength(1);
			});
		} finally {
			await ws.cleanup();
		}
	});

	test("通知投递后的 Read 进入足迹，携带投递后的新版本", async () => {
		const ws = await makeTempWorkbench();
		try {
			const target = join(ws.projectDir, "premise.txt");
			await writeFile(target, "v1", "utf8");
			const fake = String.raw`
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");
const line = (value) => process.stdout.write(JSON.stringify(value) + "\n");
line({ type: "system", subtype: "init", session_id: "reread-session" });
let buffer = "";
let turns = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\n");
    if (end < 0) break;
    const raw = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!raw) continue;
    appendFileSync(join(__dirname, "prompts.log"), raw + "\n");
    turns += 1;
    if (turns === 1) {
      line({ type: "assistant", message: { content: [{ type: "text", text: "first ok" }] } });
      line({ type: "result", subtype: "success", result: "first ok" });
      return;
    }
    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "premise.txt" } }] } });
    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "v2" }] } });
    line({ type: "assistant", message: { content: [{ type: "text", text: "second ok" }] } });
    line({ type: "result", subtype: "success", result: "second ok" });
    setTimeout(() => process.exit(0), 10);
  }
});
`;
			await withFakeAgent(fake, "workbench-notice-reread-", async () => {
				const chat = new ChatThreads(ws.bb);
				const thread = await chat.create();
				await chat.run(thread.id, "first", () => {});

				// 外部写入使前提失效，通知排队后随下一轮投递
				await writeFile(target, "v2", "utf8");
				await chat.notifySession(thread.id, "premise.txt 已变化");
				await chat.run(thread.id, "second", () => {});

				// 投递后 agent 的重读进入了读集足迹，版本是投递后的新版本
				const view = await ws.bb.sessions.readSetView(thread.id);
				expect(view.reads.get("premise.txt")?.version).toBe(
					await hashFile(target),
				);
				const delivered = await ws.bb.events.query({
					type: "premise_notice_delivered",
				});
				expect(delivered[0]?.payload).toMatchObject({
					readObservability: "footprint",
				});
			});
		} finally {
			await ws.cleanup();
		}
	});

	test("HTTP 通道投递通知后显式记录读不可观测", async () => {
		const ws = await makeTempWorkbench();
		const originalFetch = globalThis.fetch;
		try {
			await ws.bb.config.save({
				...workbenchConfigSchema.parse({}),
				chat: { provider: "openai-chat", apiKey: "test-key" },
			});
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			await chat.notifySession(thread.id, "HTTP 通知");
			globalThis.fetch = (async () =>
				new Response(
					`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`,
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				)) as unknown as typeof fetch;

			await chat.run(thread.id, "ask", () => {});
			const delivered = await ws.bb.events.query({
				type: "premise_notice_delivered",
			});
			expect(delivered).toHaveLength(1);
			// HTTP provider 没有 tool 通道：投递后的 Read 无法进入足迹，
			// 事件里必须显式记录为不可观测，而不是静默假设可观测。
			expect(delivered[0]?.payload).toMatchObject({
				readObservability: "unobservable",
			});
		} finally {
			globalThis.fetch = originalFetch;
			await ws.cleanup();
		}
	});

	test("HTTP turn in flight 时 queued 事件也如实记录 turn-in-flight", async () => {
		const ws = await makeTempWorkbench();
		const originalFetch = globalThis.fetch;
		try {
			await ws.bb.config.save({
				...workbenchConfigSchema.parse({}),
				chat: { provider: "openai-chat", apiKey: "test-key" },
			});
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			let started = false;
			let resolveFetch!: (response: Response) => void;
			globalThis.fetch = (() => {
				started = true;
				return new Promise<Response>((resolve) => {
					resolveFetch = resolve;
				});
			}) as unknown as typeof fetch;

			const turn = chat.run(thread.id, "ask", () => {});
			while (!started) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			expect(await chat.notifySession(thread.id, "轮内 HTTP 通知")).toBe(
				"queued",
			);
			const queued = await ws.bb.events.query({
				type: "premise_notice_queued",
			});
			expect(queued[0]?.payload).toMatchObject({
				writer: thread.id,
				reason: "turn-in-flight",
			});

			resolveFetch(
				new Response(
					`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`,
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
			);
			await turn;
			// 本轮已 drain 过：通知留到下一轮，不随本轮投递
			expect(
				await ws.bb.events.query({ type: "premise_notice_delivered" }),
			).toHaveLength(0);
			expect(await pathExists(noticesFile(ws.workbenchRoot, thread.id))).toBe(
				true,
			);
		} finally {
			globalThis.fetch = originalFetch;
			await ws.cleanup();
		}
	});
});

describe("ChatThreads 每轮 provider 与读集可观测性（TF-0191）", () => {
	test("新线程无 lastRun；HTTP 轮次记 unobservable；换成 claude 后同一线程改记 footprint", async () => {
		const ws = await makeTempWorkbench();
		const fakeDir = await mkdtemp(join(tmpdir(), "workbench-lastrun-agent-"));
		const originalFetch = globalThis.fetch;
		const previousCommand = process.env.WORKBENCH_CHAT_COMMAND;
		try {
			const chat = new ChatThreads(ws.bb);
			const thread = await chat.create();
			expect((await chat.get(thread.id)).lastRun).toBeUndefined();

			await ws.bb.config.save({
				...workbenchConfigSchema.parse({}),
				chat: { provider: "openai-chat", apiKey: "test-key" },
			});
			globalThis.fetch = (async () =>
				new Response(
					`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\ndata: [DONE]\n\n`,
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				)) as unknown as typeof fetch;
			await chat.run(thread.id, "http turn", () => {});
			expect((await chat.get(thread.id)).lastRun).toMatchObject({
				provider: "openai-chat",
				readObservability: "unobservable",
			});

			const fake = String.raw`
const line = (value) => process.stdout.write(JSON.stringify(value) + "\n");
line({ type: "system", subtype: "init", session_id: "s" });
process.stdin.setEncoding("utf8");
process.stdin.once("data", () => {
  line({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
  line({ type: "result", subtype: "success", result: "ok" });
  setTimeout(() => process.exit(0), 5);
});
`;
			await writeFile(join(fakeDir, "agent.js"), fake, "utf8");
			process.env.WORKBENCH_CHAT_COMMAND = `bun ${join(fakeDir, "agent.js")}`;
			await ws.bb.config.save({
				...workbenchConfigSchema.parse({}),
				chat: { provider: "claude" },
			});
			await chat.run(thread.id, "claude turn", () => {});
			for (let attempt = 0; attempt < 40; attempt += 1) {
				if (!chatContext(chat).live.has(thread.id)) break;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			expect((await chat.get(thread.id)).lastRun).toMatchObject({
				provider: "claude",
				readObservability: "footprint",
			});
		} finally {
			globalThis.fetch = originalFetch;
			if (previousCommand === undefined) {
				delete process.env.WORKBENCH_CHAT_COMMAND;
			} else {
				process.env.WORKBENCH_CHAT_COMMAND = previousCommand;
			}
			await rm(fakeDir, { recursive: true, force: true });
			await ws.cleanup();
		}
	});
});
