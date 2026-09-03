import { describe, expect, test } from "bun:test";
import { buildResumeNote, resumeDelta } from "./resume";
import type { StoredMessage } from "./threads";

function msg(
	role: "user" | "assistant",
	text: string,
	extra?: Partial<StoredMessage>,
): StoredMessage {
	return {
		id: `m-${Math.random().toString(36).slice(2, 8)}`,
		role,
		text,
		at: new Date().toISOString(),
		...extra,
	};
}

const fixedNow = new Date("2026-09-02T10:00:00Z");

describe("buildResumeNote（TF-0097）", () => {
	test("空对话返回 null——没有可记的事就不记", () => {
		expect(buildResumeNote([], {}, fixedNow)).toBeNull();
	});

	test("只有 user 消息：doing + next（next 来自 suggest 发散兜底）", () => {
		const note = buildResumeNote(
			[msg("user", "调研上下文回退方案")],
			{},
			fixedNow,
		);
		expect(note).not.toBeNull();
		expect(note!.beats[0]!.kind).toBe("doing");
		expect(note!.beats[0]!.text).toBe("调研上下文回退方案");
		// suggestNext 要求最后一条是 assistant 才提议；这里最后是 user → 无 next
		expect(note!.beats.some((b) => b.kind === "next")).toBe(false);
		expect(note!.draftedAt).toBe(fixedNow.toISOString());
	});

	test("user + assistant：doing + next（next 复用 suggestNext）", () => {
		const note = buildResumeNote(
			[
				msg("user", "怎么实现恢复笔记"),
				msg("assistant", "可以分四步：\n1. 先写纯函数推导\n2. 再接线持久化"),
			],
			{},
			fixedNow,
		);
		expect(note).not.toBeNull();
		const kinds = note!.beats.map((b) => b.kind);
		expect(kinds).toContain("doing");
		expect(kinds).toContain("next");
		const next = note!.beats.find((b) => b.kind === "next")!;
		expect(next.text).toContain("下一步可以：");
		expect(next.text).toContain("先写纯函数推导");
	});

	test("有分叉决策点：decided 节拍叙事分叉路径", () => {
		const user = msg("user", "选哪个方案");
		const assistant = msg("assistant", "我建议 A");
		const note = buildResumeNote(
			[user, assistant],
			{ forks: { [assistant.id]: 2 } },
			fixedNow,
		);
		const decided = note!.beats.find((b) => b.kind === "decided")!;
		expect(decided.text).toContain("分叉出 2 条路径");
	});

	test("有晋升记录：decided 节拍叙事命名", () => {
		const note = buildResumeNote(
			[msg("user", "做恢复笔记"), msg("assistant", "好")],
			{
				promotion: {
					at: "2026-09-01T00:00:00Z",
					signals: [],
					title: "恢复笔记",
				},
			},
			fixedNow,
		);
		const decided = note!.beats.find((b) => b.kind === "decided")!;
		expect(decided.text).toContain("命名为「恢复笔记」");
	});

	test("assistant 带 tool-call：shifted 节拍叙事动了什么", () => {
		const note = buildResumeNote(
			[
				msg("user", "改一下 resume.ts"),
				msg("assistant", "改好了", {
					parts: [
						{ type: "text", text: "改好了" },
						{
							type: "tool-call",
							toolCallId: "tc1",
							toolName: "edit",
							args: { file_path: "src/chat/resume.ts" },
						},
						{
							type: "tool-call",
							toolCallId: "tc2",
							toolName: "run",
							args: { command: "bun test" },
						},
					],
				}),
			],
			{},
			fixedNow,
		);
		const shifted = note!.beats.find((b) => b.kind === "shifted")!;
		expect(shifted.text).toContain("动了 2 处");
		expect(shifted.text).toContain("edit(src/chat/resume.ts)");
		expect(shifted.text).toContain("run(bun test)");
	});

	test("节拍封顶 5 个", () => {
		// 构造一个能产生 doing + decided(2) + shifted + next = 5 的对话
		const assistant = msg("assistant", "好\n1. 第一步\n2. 第二步", {
			parts: [
				{ type: "text", text: "好" },
				{
					type: "tool-call",
					toolCallId: "tc1",
					toolName: "edit",
					args: { file_path: "a.ts" },
				},
			],
		});
		const note = buildResumeNote(
			[msg("user", "做完了"), assistant],
			{
				forks: { [assistant.id]: 1 },
				promotion: { at: "x", signals: [], title: "T" },
			},
			fixedNow,
		);
		expect(note!.beats.length).toBeLessThanOrEqual(5);
	});

	test("leaveSignature 记录离开时的消息数与最后消息时间", () => {
		const messages = [
			msg("user", "a", { at: "2026-09-01T10:00:00Z" }),
			msg("assistant", "b", { at: "2026-09-01T11:00:00Z" }),
		];
		const note = buildResumeNote(messages, {}, fixedNow);
		expect(note!.leaveSignature.messageCount).toBe(2);
		expect(note!.leaveSignature.lastMessageAt).toBe("2026-09-01T11:00:00Z");
	});
});

describe("resumeDelta（TF-0097 返回时检测）", () => {
	test("消息数没变：返回 0", () => {
		const note = buildResumeNote(
			[msg("user", "a"), msg("assistant", "b")],
			{},
			fixedNow,
		)!;
		expect(resumeDelta([msg("user", "a"), msg("assistant", "b")], note)).toBe(
			0,
		);
	});

	test("离开后多了消息：返回新增条数", () => {
		const note = buildResumeNote(
			[msg("user", "a"), msg("assistant", "b")],
			{},
			fixedNow,
		)!;
		expect(
			resumeDelta(
				[
					msg("user", "a"),
					msg("assistant", "b"),
					msg("user", "c"),
					msg("assistant", "d"),
				],
				note,
			),
		).toBe(2);
	});

	test("消息变少（reload 截断）：返回 0，不报负数", () => {
		const note = buildResumeNote(
			[msg("user", "a"), msg("assistant", "b"), msg("user", "c")],
			{},
			fixedNow,
		)!;
		expect(resumeDelta([msg("user", "a")], note)).toBe(0);
	});
});
