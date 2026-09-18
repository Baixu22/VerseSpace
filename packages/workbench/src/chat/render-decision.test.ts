import { describe, expect, test } from "bun:test";
import {
	createClaudeRenderState,
	reduceClaudeRenderEvent,
} from "./claude-render-state";

const content = (type: string, block: unknown) => ({
	type,
	message: { content: [block] },
});
const stream = (event: Record<string, unknown>) => ({
	type: "stream_event",
	event,
});

const unknowns: Array<[Record<string, unknown>, string]> = [
	[{ type: "future_event" }, "future_event"],
	[{ type: "constructor" }, "constructor"],
	[{ type: "system", subtype: "future_system" }, "system.future_system"],
	[stream({ type: "future_stream" }), "stream_event.future_stream"],
	[
		stream({ type: "content_block_delta", delta: { type: "future_delta" } }),
		"stream_event.content_block_delta.future_delta",
	],
	[
		stream({
			type: "content_block_start",
			content_block: { type: "future_block" },
		}),
		"stream_event.content_block_start.future_block",
	],
	[
		content("assistant", { type: "future_visible_block" }),
		"assistant.content.future_visible_block",
	],
	[content("user", { type: "future_result" }), "user.content.future_result"],
	[content("assistant", null), "assistant.content.(missing)"],
	[
		content("assistant", "untyped visible content"),
		"assistant.content.(missing)",
	],
	[content("assistant", { type: "toString" }), "assistant.content.toString"],
];

describe("explicit Claude render decisions", () => {
	test.each(unknowns)("fails closed for %j as %s", (event, path) => {
		const state = createClaudeRenderState();
		expect(reduceClaudeRenderEvent(state, event)).toMatchObject({
			decision: "undecided",
			decisionKey: path,
			events: [],
			newToolBlocks: [],
			toolResultBlocks: [],
		});
		expect(state.messageParts).toEqual([]);
	});

	test("an unknown sibling prevents partial rendering of a known envelope", () => {
		const state = createClaudeRenderState();
		expect(
			reduceClaudeRenderEvent(state, {
				type: "assistant",
				message: {
					content: [
						{ type: "text", text: "must not partly render" },
						{ type: "future_image" },
					],
				},
			}),
		).toMatchObject({
			decision: "undecided",
			decisionKey: "assistant.content.future_image",
		});
		expect(state.messageParts).toEqual([]);
	});

	test.each([
		"thinking",
		"signature",
		"redacted_thinking",
	])("%s content is an explicit noop", (type) => {
		const state = createClaudeRenderState();
		expect(
			reduceClaudeRenderEvent(state, content("assistant", { type })),
		).toMatchObject({
			decision: "noop",
			decisionKey: `assistant.content.${type}`,
			events: [],
		});
		expect(state.messageParts).toEqual([]);
	});

	test.each([
		"thinking_delta",
		"signature_delta",
		"input_json_delta",
	])("%s is an explicit noop", (type) => {
		expect(
			reduceClaudeRenderEvent(
				createClaudeRenderState(),
				stream({
					type: "content_block_delta",
					delta: { type },
				}),
			),
		).toMatchObject({
			decision: "noop",
			decisionKey: `stream_event.content_block_delta.${type}`,
			events: [],
		});
	});
});
