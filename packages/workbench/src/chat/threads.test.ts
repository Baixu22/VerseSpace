import { describe, expect, test } from "bun:test";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
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
