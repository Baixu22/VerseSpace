import { describe, expect, test } from "bun:test";
import { anthropicCodec } from "./anthropic";
import { classifyFailure, kindFromStatus } from "./errors";
import { openAiChatCodec } from "./openai-chat";
import { openAiResponsesCodec } from "./openai-responses";
import {
	cacheHitRatio,
	finalizeUsage,
	mergeUsage,
	type ParsedFrame,
	type ProtocolCodec,
} from "./types";

const json = (value: unknown) => JSON.stringify(value);

function parseAll(codec: ProtocolCodec, payloads: unknown[]): ParsedFrame[] {
	return payloads.flatMap((p) =>
		codec.parse(typeof p === "string" ? p : json(p)),
	);
}

describe("OpenAI Chat Completions codec", () => {
	test("asks for usage on the stream and sends the cache key", () => {
		const body = openAiChatCodec.body({
			model: "gpt-4o-mini",
			turns: [{ role: "user", content: "hi" }],
			cacheKey: "thread-1",
		});
		expect(body.stream_options).toEqual({ include_usage: true });
		expect(body.prompt_cache_key).toBe("thread-1");
	});

	test("reads text, finish, and cached usage from the final chunk", () => {
		const frames = parseAll(openAiChatCodec, [
			{ choices: [{ delta: { content: "你好" } }] },
			{ choices: [{ delta: {}, finish_reason: "stop" }] },
			{
				choices: [],
				usage: {
					prompt_tokens: 1200,
					completion_tokens: 40,
					prompt_tokens_details: { cached_tokens: 1024 },
				},
			},
			"[DONE]",
		]);
		expect(frames[0]!.text).toBe("你好");
		expect(frames[1]!.terminal).toBe(true);
		expect(frames[2]!.usage).toEqual({
			promptTokens: 1200,
			outputTokens: 40,
			cachedTokens: 1024,
		});
		expect(frames[3]!.terminal).toBe(true);
	});

	test("an in-stream error is classified, not just reported", () => {
		const [frame] = parseAll(openAiChatCodec, [
			{ error: { message: "Rate limit reached", type: "rate_limit_exceeded" } },
		]);
		expect(frame!.error?.kind).toBe("rate");
	});

	test("a content_filter finish is a refusal, not a clean answer", () => {
		const [frame] = parseAll(openAiChatCodec, [
			{ choices: [{ delta: {}, finish_reason: "content_filter" }] },
		]);
		expect(frame!.error?.kind).toBe("content_filter");
		expect(frame!.terminal).toBeUndefined();
	});

	test("an unparseable payload is malformed, never silently dropped", () => {
		expect(parseAll(openAiChatCodec, ["{not json"])).toEqual([
			{ malformed: true },
		]);
	});
});

describe("OpenAI Responses codec", () => {
	test("streams output_text deltas and completes with cached usage", () => {
		const frames = parseAll(openAiResponsesCodec, [
			{ type: "response.output_text.delta", delta: "好" },
			{
				type: "response.completed",
				response: {
					usage: {
						input_tokens: 2000,
						output_tokens: 9,
						input_tokens_details: { cached_tokens: 1536 },
					},
				},
			},
		]);
		expect(frames[0]!.text).toBe("好");
		expect(frames[1]!.terminal).toBe(true);
		expect(frames[1]!.usage).toEqual({
			promptTokens: 2000,
			outputTokens: 9,
			cachedTokens: 1536,
		});
	});

	test("a max_output_tokens stop is still a complete (truncated) answer", () => {
		const [frame] = parseAll(openAiResponsesCodec, [
			{
				type: "response.incomplete",
				response: { incomplete_details: { reason: "max_output_tokens" } },
			},
		]);
		expect(frame!.terminal).toBe(true);
		expect(frame!.error).toBeUndefined();
	});

	test("response.failed carries its error code into classification", () => {
		const [frame] = parseAll(openAiResponsesCodec, [
			{
				type: "response.failed",
				response: {
					error: {
						code: "insufficient_quota",
						message: "You exceeded your current quota",
					},
				},
			},
		]);
		expect(frame!.error?.kind).toBe("quota");
	});

	test("server-side storage is allowed explicitly (store: true)", () => {
		const body = openAiResponsesCodec.body({
			model: "gpt-4o-mini",
			turns: [],
		});
		expect(body.store).toBe(true);
	});
});

describe("Anthropic codec", () => {
	test("sums uncached, read and written input into one prompt count", () => {
		const frames = parseAll(anthropicCodec, [
			{
				type: "message_start",
				message: {
					usage: {
						input_tokens: 50,
						cache_read_input_tokens: 1800,
						cache_creation_input_tokens: 150,
						output_tokens: 1,
					},
				},
			},
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 88 },
			},
		]);
		const usage = finalizeUsage(
			mergeUsage(mergeUsage(undefined, frames[0]!.usage), frames[1]!.usage),
		);
		expect(usage).toEqual({
			promptTokens: 2000,
			cachedTokens: 1800,
			cacheWriteTokens: 150,
			outputTokens: 88,
		});
		expect(cacheHitRatio(usage!)).toBeCloseTo(0.9);
	});

	test("error types map to classes without guessing from the message", () => {
		const kind = (type: string) =>
			parseAll(anthropicCodec, [
				{ type: "error", error: { type, message: "x" } },
			])[0]!.error!.kind;
		expect(kind("overloaded_error")).toBe("overloaded");
		expect(kind("rate_limit_error")).toBe("rate");
		expect(kind("api_error")).toBe("server");
		expect(kind("authentication_error")).toBe("auth");
		expect(kind("not_found_error")).toBe("model_missing");
	});

	test("stop_reason refusal is a content filter, and message_stop terminates", () => {
		const frames = parseAll(anthropicCodec, [
			{ type: "message_delta", delta: { stop_reason: "refusal" } },
			{ type: "message_stop" },
		]);
		expect(frames[0]!.error?.kind).toBe("content_filter");
		expect(frames[1]!.terminal).toBe(true);
	});

	test("long sessions use the 1-hour TTL; short ones keep the 5-minute default", () => {
		expect(
			anthropicCodec.body({ model: "m", turns: [], longSession: true })
				.cache_control,
		).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(
			anthropicCodec.body({ model: "m", turns: [] }).cache_control,
		).toEqual({ type: "ephemeral" });
	});

	test("max_tokens is always present, because the protocol requires it", () => {
		const body = anthropicCodec.body({ model: "m", turns: [] });
		expect(body.max_tokens).toBe(1024);
		expect(body.cache_control).toEqual({ type: "ephemeral" });
	});
});

describe("failure classification", () => {
	test("text beats status: a 429 that is really a quota is not a rate limit", () => {
		expect(
			classifyFailure({ status: 429, message: "insufficient_quota" }),
		).toBe("quota");
		expect(classifyFailure({ status: 429, message: "slow down" })).toBe("rate");
	});

	test("a 400 that says the context is too long switches, it is not a bad request", () => {
		expect(
			classifyFailure({
				status: 400,
				message: "This model's maximum context length is 128000 tokens",
			}),
		).toBe("context_overflow");
	});

	test("status fallbacks cover the common HTTP classes", () => {
		expect(kindFromStatus(401)).toBe("auth");
		expect(kindFromStatus(403)).toBe("auth");
		expect(kindFromStatus(404)).toBe("model_missing");
		expect(kindFromStatus(408)).toBe("timeout");
		expect(kindFromStatus(429)).toBe("rate");
		expect(kindFromStatus(529)).toBe("overloaded");
		expect(kindFromStatus(502)).toBe("server");
		expect(kindFromStatus(400)).toBe("bad_request");
	});
});

describe("usage normalisation", () => {
	test("later frames override fields without erasing earlier ones", () => {
		const merged = mergeUsage(
			mergeUsage(undefined, { promptTokens: 10, cachedTokens: 4 }),
			{ outputTokens: 3, cachedTokens: undefined },
		);
		expect(merged).toEqual({
			promptTokens: 10,
			cachedTokens: 4,
			outputTokens: 3,
		});
	});

	test("no prompt count means no usage record at all", () => {
		expect(finalizeUsage({ outputTokens: 5 })).toBeUndefined();
	});

	test("cached tokens are capped at the prompt size", () => {
		expect(
			finalizeUsage({ promptTokens: 10, cachedTokens: 99 })!.cachedTokens,
		).toBe(10);
	});

	test("a zero-length prompt has no hit rate", () => {
		expect(
			cacheHitRatio({
				promptTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 0,
				outputTokens: 0,
			}),
		).toBeNull();
	});
});
