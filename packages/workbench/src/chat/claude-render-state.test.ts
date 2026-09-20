import { describe, expect, test } from "bun:test";
import {
	createClaudeRenderState,
	finalClaudeParts,
	reduceClaudeRenderEvent,
} from "./claude-render-state";

const assistant = (id: string, content: Record<string, unknown>[]) => ({
	type: "assistant",
	message: { id, content },
});
const text = (value: string) => ({ type: "text" as const, text: value });
const tool = (
	id: string,
	name = "Read",
	input: unknown = { file_path: `${id}.ts` },
) => ({
	type: "tool_use",
	id,
	name,
	input,
});
const textDelta = (value: string, index?: number) => ({
	type: "stream_event",
	event: {
		type: "content_block_delta",
		index,
		delta: { type: "text_delta", text: value },
	},
});

describe("Claude render reducer", () => {
	test("reconciles token deltas with finalized text once, including correction", () => {
		const state = createClaudeRenderState();
		expect(reduceClaudeRenderEvent(state, textDelta("Hello ")).events).toEqual([
			{ type: "delta", text: "Hello " },
		]);
		reduceClaudeRenderEvent(state, textDelta("world"));
		const frame = assistant("m1", [text("Hello world")]);
		expect(reduceClaudeRenderEvent(state, frame).events).toEqual([]);
		expect(reduceClaudeRenderEvent(state, frame).events).toEqual([]);
		expect(state.pendingText).toBeUndefined();
		reduceClaudeRenderEvent(state, textDelta("incomplete"));
		expect(
			reduceClaudeRenderEvent(state, assistant("m2", [text("corrected")]))
				.events,
		).toEqual([
			{
				type: "parts",
				parts: [{ type: "text", text: "Hello worldcorrected" }],
			},
		]);
	});

	test("consumes every finalized text and tool block without any stream deltas", () => {
		const state = createClaudeRenderState();
		const frame = assistant("m1", [
			text("before"),
			tool("r1"),
			text("after"),
			text("!"),
		]);
		reduceClaudeRenderEvent(state, frame);
		expect(finalClaudeParts(state)).toEqual([
			text("before"),
			{
				type: "tool-call",
				toolCallId: "r1",
				toolName: "Read",
				args: { file_path: "r1.ts" },
			},
			text("after!"),
		]);
		expect(reduceClaudeRenderEvent(state, frame).events).toEqual([]);
	});

	test("distinguishes cumulative snapshots from delta-style assistant frames", () => {
		const state = createClaudeRenderState();
		const read = tool("r1");
		const glob = tool("g1", "Glob", { pattern: "*.ts" });
		reduceClaudeRenderEvent(state, assistant("m1", [read]));
		const cumulative = reduceClaudeRenderEvent(
			state,
			assistant("m1", [read, glob]),
		);
		expect(cumulative.newToolBlocks).toEqual([glob]);
		expect(state.messageParts).toHaveLength(2);
		expect(
			reduceClaudeRenderEvent(state, assistant("m1", [read, glob])).events,
		).toEqual([]);
		reduceClaudeRenderEvent(state, assistant("m1", [text("done")]));
		expect(state.messageParts.at(-1)).toEqual(text("done"));
	});

	test("replays older messages idempotently and expands cumulative text", () => {
		const state = createClaudeRenderState();
		reduceClaudeRenderEvent(state, assistant("m1", [text("Hello")]));
		reduceClaudeRenderEvent(state, assistant("m1", [text("Hello world")]));
		expect(
			reduceClaudeRenderEvent(state, assistant("m1", [text("Hello")])).events,
		).toEqual([]);
		expect(finalClaudeParts(state)).toEqual([text("Hello world")]);
		reduceClaudeRenderEvent(state, assistant("m2", [text("Hello world")]));
		expect(
			reduceClaudeRenderEvent(state, assistant("m1", [text("Hello world")]))
				.events,
		).toEqual([]);
		expect(finalClaudeParts(state)).toEqual([text("Hello worldHello world")]);
	});

	test("upserts tool IDs and changed args without clearing a settled result", () => {
		const state = createClaudeRenderState();
		reduceClaudeRenderEvent(state, assistant("m1", [tool("r1")]));
		reduceClaudeRenderEvent(state, {
			type: "user",
			message: {
				content: [{ type: "tool_result", tool_use_id: "r1", content: "ok" }],
			},
		});
		const result = reduceClaudeRenderEvent(
			state,
			assistant("m1", [tool("r1", "Read", { file_path: "new.ts" })]),
		);
		expect(result.newToolBlocks).toEqual([]);
		expect(result.events).toHaveLength(1);
		expect(state.messageParts).toHaveLength(1);
		expect(state.messageParts[0]).toMatchObject({
			result: "ok",
			args: { file_path: "new.ts" },
		});
	});

	test("patches every tool result in a multi-result envelope and settles groups", () => {
		const state = createClaudeRenderState();
		reduceClaudeRenderEvent(state, assistant("m1", [tool("r1"), tool("r2")]));
		const event = {
			type: "user",
			message: {
				content: [
					{ type: "tool_result", tool_use_id: "r1", content: "first" },
					{
						type: "tool_result",
						tool_use_id: "r2",
						content: "second",
						is_error: true,
					},
				],
			},
		};
		const result = reduceClaudeRenderEvent(state, event);
		expect(result.toolResultBlocks).toHaveLength(2);
		expect(result.events[0]).toMatchObject({
			type: "parts",
			parts: [
				{
					type: "collapsed-group",
					active: false,
					tools: [{ result: "first" }, { result: "second", isError: true }],
				},
			],
		});
		expect(reduceClaudeRenderEvent(state, event).events).toEqual([]);
		expect(finalClaudeParts(state)[0]).toMatchObject({ active: false });
	});

	test.each([
		"assistant",
		"user",
	])("supports standard and MCP results in %s", (role) => {
		const state = createClaudeRenderState();
		reduceClaudeRenderEvent(
			state,
			assistant("m1", [
				{ ...tool("mcp", "read_text_file"), type: "mcp_tool_use" },
				tool("standard"),
			]),
		);
		const result = reduceClaudeRenderEvent(state, {
			type: role,
			message: {
				id: "m1",
				content: [
					{
						type: "mcp_tool_result",
						tool_use_id: "mcp",
						content: [{ type: "text", text: "denied" }],
						is_error: true,
					},
					{ type: "tool_result", tool_use_id: "standard", content: "ok" },
				],
			},
		});
		expect(result.toolResultBlocks).toHaveLength(2);
		expect(state.messageParts).toMatchObject([
			{ result: [{ type: "text", text: "denied" }], isError: true },
			{ result: "ok" },
		]);
	});

	test("stream block indexes distinguish identical consecutive text blocks", () => {
		const state = createClaudeRenderState();
		reduceClaudeRenderEvent(state, {
			type: "stream_event",
			event: { type: "message_start", message: { id: "m1" } },
		});
		for (const index of [0, 1]) {
			reduceClaudeRenderEvent(state, {
				type: "stream_event",
				event: { type: "content_block_start", index, content_block: text("") },
			});
			reduceClaudeRenderEvent(state, textDelta("same", index));
			expect(
				reduceClaudeRenderEvent(state, assistant("m1", [text("same")])).events,
			).toEqual([]);
		}
		expect(finalClaudeParts(state)).toEqual([text("samesame")]);
		expect(
			reduceClaudeRenderEvent(
				state,
				assistant("m1", [text("same"), text("same")]),
			).events,
		).toEqual([]);
	});

	test("result-only success fallback belongs to the pure reducer and is idempotent", () => {
		const state = createClaudeRenderState();
		const success = { type: "result", subtype: "success", result: "fallback" };
		// 从严更新（TF-0200 follow-up）：没有模型动作的回合，兜底文本前面多了
		// 一条通知 —— 正文一个字不变，但不再读起来像真回答。
		expect(reduceClaudeRenderEvent(state, success).events).toEqual([
			{ type: "delta", text: "fallback" },
			{
				type: "parts",
				parts: [
					{
						type: "notice",
						severity: "warning",
						label: "本轮没有模型输出",
						body: expect.stringContaining("No response requested."),
					},
					{ type: "text", text: "fallback" },
				],
			},
		]);
		expect(reduceClaudeRenderEvent(state, success).events).toEqual([]);
		expect(finalClaudeParts(state)).toEqual([
			{
				type: "notice",
				severity: "warning",
				label: "本轮没有模型输出",
				body: expect.stringContaining("No response requested."),
			},
			text("fallback"),
		]);
		const failed = createClaudeRenderState();
		expect(
			reduceClaudeRenderEvent(failed, { ...success, is_error: true }).events,
		).toEqual([]);
		expect(failed.messageParts).toEqual([]);
	});

	test("final folding does not mutate raw message parts", () => {
		const state = createClaudeRenderState();
		reduceClaudeRenderEvent(
			state,
			assistant("m1", [text("a"), text("b"), tool("r1"), tool("r2")]),
		);
		const before = structuredClone(state.messageParts);
		expect(finalClaudeParts(state)).toMatchObject([
			text("ab"),
			{ type: "collapsed-group", active: false },
		]);
		expect(state.messageParts).toEqual(before);
	});
});
