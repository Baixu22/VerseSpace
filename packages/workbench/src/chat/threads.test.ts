import { describe, expect, test } from "bun:test";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { workbenchConfigSchema } from "../types/config";
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
