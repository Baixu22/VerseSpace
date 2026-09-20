import { describe, expect, test } from "bun:test";
import {
	createClaudeRenderState,
	finalClaudeParts,
	foldedClaudeParts,
	reduceClaudeRenderEvent,
} from "./claude-render-state";

const receipt = "No response requested.";

function turn(lines: Record<string, unknown>[]) {
	const state = createClaudeRenderState();
	const results = lines.map((line) => reduceClaudeRenderEvent(state, line));
	return { state, results };
}

describe("无模型输出的回合要自我标注（TF-0200 follow-up）", () => {
	test("回执文本照旧落盘，正文前面多一条通知", () => {
		const { state, results } = turn([
			{ type: "system", subtype: "init", session_id: "s" },
			{ type: "result", subtype: "success", result: receipt },
		]);
		const last = results.at(-1)!;
		// delta 照发：provider 的话一个字不改
		expect(
			last.events.some(
				(event) => event.type === "delta" && event.text === receipt,
			),
		).toBe(true);
		// 通知在正文之前 —— 先看到「这不是回答」，再看到内容
		const partsEvent = last.events.find((event) => event.type === "parts");
		const parts =
			partsEvent && partsEvent.type === "parts" ? partsEvent.parts : null;
		expect(parts).toEqual([
			{
				type: "notice",
				severity: "warning",
				label: "本轮没有模型输出",
				body: expect.stringContaining("No response requested."),
			},
			{ type: "text", text: receipt },
		]);
		// 落盘形状与流式一致：done 不会比正在流式的那一帧多或少什么
		expect(finalClaudeParts(state)).toEqual(foldedClaudeParts(state, false));
	});

	test("真回答不受影响：已有正文就不触发兜底，也不加通知", () => {
		const { state, results } = turn([
			{
				type: "assistant",
				message: { content: [{ type: "text", text: "看完了" }] },
			},
			{ type: "result", subtype: "success", result: receipt },
		]);
		expect(state.messageParts).toEqual([{ type: "text", text: "看完了" }]);
		expect(results.at(-1)!.events).toEqual([]);
	});

	test("有工具调用但没有文本：result 照旧兜底成正文，不加通知", () => {
		const { state, results } = turn([
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "r1",
							name: "Read",
							input: { file_path: "x.ts" },
						},
					],
				},
			},
			{
				type: "user",
				message: {
					content: [{ type: "tool_result", tool_use_id: "r1", content: "ok" }],
				},
			},
			{ type: "result", subtype: "success", result: receipt },
		]);
		expect(state.messageParts.map((part) => part.type)).toEqual([
			"tool-call",
			"text",
		]);
		const last = results.at(-1)!;
		// delta 发了，但这轮没有通知、也没有额外的 parts 快照
		expect(last.events.map((event) => event.type)).toEqual(["delta"]);
		expect(state.messageParts.some((part) => part.type === "notice")).toBe(
			false,
		);
	});

	test("空 result 维持既有行为：不推正文也不加通知", () => {
		const { state, results } = turn([
			{ type: "result", subtype: "success", result: "" },
		]);
		expect(state.messageParts).toEqual([]);
		expect(results.at(-1)!.events).toEqual([]);
	});

	test("判据是结构性的：换什么回执话都标注，有模型动作就不标", () => {
		// 同一批输入喂新旧两种形状：纯回执必须被标，带模型动作的不许被标
		for (const line of ["No response requested.", "queued.", "随便什么回执"]) {
			const { state } = turn([
				{ type: "result", subtype: "success", result: line },
			]);
			expect(state.messageParts.at(0)?.type).toBe("notice");
		}
		const { state: answered } = turn([
			{
				type: "assistant",
				message: {
					content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
				},
			},
			{ type: "result", subtype: "success", result: receipt },
		]);
		expect(answered.messageParts.some((part) => part.type === "notice")).toBe(
			false,
		);
	});
});
