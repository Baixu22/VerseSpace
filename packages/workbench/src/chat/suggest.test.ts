import { describe, expect, test } from "bun:test";
import { suggestNext } from "./suggest";
import type { StoredMessage } from "./threads";

function msg(role: "user" | "assistant", text: string): StoredMessage {
	return {
		id: `m-${Math.random().toString(36).slice(2, 8)}`,
		role,
		text,
		at: new Date().toISOString(),
	};
}

describe("系统提议的下一步（TF-0095）", () => {
	test("从编号结构推导：每个建议一次点击，最多 3 条", () => {
		const answer = msg(
			"assistant",
			"有三个方向：\n1. 用 KV 缓存复用会话\n2. 用流式输入追加上下文\n3. 另起一条线程",
		);
		const suggestions = suggestNext([msg("user", "怎么继续？"), answer]);
		expect(suggestions.length).toBe(3);
		expect(suggestions[0]!.kind).toBe("option");
		expect(suggestions[0]!.text).toContain("KV 缓存复用会话");
	});

	test("从助手留下的开放问题推导", () => {
		const answer = msg(
			"assistant",
			"方案可行，但有一个前提要确认：数据库迁移是否允许停机窗口？",
		);
		const suggestions = suggestNext([answer]);
		expect(suggestions[0]!.kind).toBe("question");
		expect(suggestions[0]!.text).toContain("停机窗口");
	});

	test("回答没有结构时回退到发散方向；最后不是助手回答时返回空", () => {
		const plain = msg("assistant", "好的，已经完成了修改。");
		expect(suggestNext([plain]).every((s) => s.kind === "diverge")).toBe(true);
		expect(suggestNext([plain])).toHaveLength(3);
		expect(suggestNext([msg("user", "只有一条用户消息")])).toEqual([]);
		expect(suggestNext([])).toEqual([]);
	});
});
