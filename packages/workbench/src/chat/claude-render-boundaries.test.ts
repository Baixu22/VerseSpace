import { describe, expect, test } from "bun:test";
import {
	createClaudeRenderState,
	finalClaudeParts,
	reduceClaudeRenderEvent,
} from "./claude-render-state";

const text = (value: string) => ({ type: "text" as const, text: value });
const assistant = (id: string, content: Record<string, unknown>[]) => ({
	type: "assistant",
	message: { id, content },
});
const stream = (event: Record<string, unknown>) => ({
	type: "stream_event",
	event,
});
const delta = (value: string, index?: number) =>
	stream({
		type: "content_block_delta",
		index,
		delta: { type: "text_delta", text: value },
	});
const read = {
	type: "tool_use",
	id: "r1",
	name: "Read",
	input: { file_path: "a.ts" },
};

describe("Claude render text/tool boundaries", () => {
	test.each([
		false,
		true,
	])("pending text cannot cross a tool boundary (streamed=%s)", (streamed) => {
		const state = createClaudeRenderState();
		if (streamed) {
			reduceClaudeRenderEvent(
				state,
				stream({ type: "message_start", message: { id: "m1" } }),
			);
			reduceClaudeRenderEvent(
				state,
				stream({
					type: "content_block_start",
					index: 0,
					content_block: text(""),
				}),
			);
		}
		reduceClaudeRenderEvent(state, delta("intro"));
		reduceClaudeRenderEvent(state, assistant("m1", [read]));
		reduceClaudeRenderEvent(state, delta("tail"));
		reduceClaudeRenderEvent(state, assistant("m2", [text("tail")]));
		expect(finalClaudeParts(state)).toMatchObject([
			text("intro"),
			{ type: "tool-call", toolCallId: "r1" },
			text("tail"),
		]);
	});

	test("a finalized-only tail cannot overwrite pending text before a tool", () => {
		const state = createClaudeRenderState();
		reduceClaudeRenderEvent(state, delta("intro"));
		reduceClaudeRenderEvent(state, assistant("m1", [read]));
		reduceClaudeRenderEvent(state, assistant("m2", [text("tail")]));
		expect(finalClaudeParts(state)).toMatchObject([
			text("intro"),
			{ type: "tool-call" },
			text("tail"),
		]);
	});

	test("old singleton replay does not overwrite the latest streamed block", () => {
		const state = createClaudeRenderState();
		reduceClaudeRenderEvent(
			state,
			stream({ type: "message_start", message: { id: "m1" } }),
		);
		for (const [index, value] of ["intro", "tail"].entries()) {
			reduceClaudeRenderEvent(
				state,
				stream({ type: "content_block_start", index, content_block: text("") }),
			);
			reduceClaudeRenderEvent(state, delta(value, index));
			reduceClaudeRenderEvent(state, assistant("m1", [text(value)]));
		}
		expect(
			reduceClaudeRenderEvent(state, assistant("m1", [text("intro")])).events,
		).toEqual([]);
		expect(finalClaudeParts(state)).toEqual([text("introtail")]);
	});

	test("stopped stream position does not absorb a new delta-style finalized block", () => {
		const state = createClaudeRenderState();
		reduceClaudeRenderEvent(
			state,
			stream({ type: "message_start", message: { id: "m1" } }),
		);
		reduceClaudeRenderEvent(
			state,
			stream({
				type: "content_block_start",
				index: 0,
				content_block: text(""),
			}),
		);
		reduceClaudeRenderEvent(state, delta("intro", 0));
		reduceClaudeRenderEvent(state, assistant("m1", [text("intro")]));
		reduceClaudeRenderEvent(
			state,
			stream({ type: "content_block_stop", index: 0 }),
		);
		reduceClaudeRenderEvent(state, assistant("m1", [read]));
		reduceClaudeRenderEvent(state, assistant("m1", [text("tail")]));
		expect(finalClaudeParts(state)).toMatchObject([
			text("intro"),
			{ type: "tool-call" },
			text("tail"),
		]);
	});
});
