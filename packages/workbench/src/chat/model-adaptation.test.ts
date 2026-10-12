import { expect, test } from "bun:test";
import {
	isOpenAiReasoningModel,
	ModelAdaptation,
	parseRejectedParam,
} from "./model-adaptation";

const chatTarget = {
	provider: "openai-chat",
	model: "gpt-4o-mini",
	baseUrl: "https://gw.test/v1",
} as const;

test("reasoning-class OpenAI models are recognised without catching -chat", () => {
	for (const model of ["o1", "o3-mini", "o4-mini", "gpt-5", "gpt-5.1"]) {
		expect(isOpenAiReasoningModel(model)).toBe(true);
	}
	for (const model of ["gpt-5-chat-latest", "gpt-4o", "claude-sonnet-4-5"]) {
		expect(isOpenAiReasoningModel(model)).toBe(false);
	}
});

test("declared rules: reasoning model drops sampling params and renames max_tokens on chat", () => {
	const adaptation = new ModelAdaptation();
	const body = adaptation.adjust(
		{ ...chatTarget, model: "o3-mini" },
		{
			model: "o3-mini",
			messages: [],
			temperature: 0.2,
			top_p: 0.9,
			max_tokens: 256,
		},
	);
	expect(body).toEqual({
		model: "o3-mini",
		messages: [],
		max_completion_tokens: 256,
	});
});

test("declared rules leave non-reasoning models and Anthropic bodies untouched", () => {
	const adaptation = new ModelAdaptation();
	const plain = { model: "gpt-4o-mini", temperature: 0.2, max_tokens: 10 };
	expect(adaptation.adjust(chatTarget, plain)).toEqual(plain);
	const anthropic = {
		provider: "anthropic",
		model: "o3-mini",
		baseUrl: "https://a.test",
	} as const;
	expect(
		adaptation.adjust(anthropic, { temperature: 0.2, max_tokens: 5 }),
	).toEqual({ temperature: 0.2, max_tokens: 5 });
});

test("adjust never mutates the caller's body", () => {
	const adaptation = new ModelAdaptation();
	const body = { model: "o1", temperature: 0.5, max_tokens: 10 };
	adaptation.adjust({ ...chatTarget, model: "o1" }, body);
	expect(body).toEqual({ model: "o1", temperature: 0.5, max_tokens: 10 });
});

test("parseRejectedParam understands the phrasings seen across upstreams", () => {
	const cases: Array<[string, string | null]> = [
		[
			"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
			"max_tokens",
		],
		[
			"Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
			"temperature",
		],
		["temperature is not supported with this model", "temperature"],
		["gpt-5 models don't support temperature=0.3", "temperature"],
		["Unknown parameter: 'prompt_cache_key'.", "prompt_cache_key"],
		["Unrecognized request argument supplied: cache_control", "cache_control"],
		// Not an adaptable parameter: must never be guessed at.
		["Unsupported parameter: 'model'", null],
		["invalid api key", null],
		["rate limit exceeded", null],
	];
	for (const [message, expected] of cases) {
		expect(parseRejectedParam(message)).toBe(expected as never);
	}
});

test("learning drops the named parameter for that endpoint, and only once", () => {
	const adaptation = new ModelAdaptation();
	const body = { model: "gpt-4o-mini", messages: [], temperature: 0.3 };
	const learned = adaptation.learn(
		chatTarget,
		body,
		"Unsupported value: 'temperature' does not support 0.3 with this model.",
	);
	expect(learned).toBe("temperature");
	expect(adaptation.adjust(chatTarget, body)).not.toHaveProperty("temperature");
	// A second identical rejection teaches nothing new: no retry loop.
	expect(
		adaptation.learn(
			chatTarget,
			body,
			"temperature is not supported with this model",
		),
	).toBeNull();
});

test("learning is scoped to the endpoint: another gateway keeps its parameters", () => {
	const adaptation = new ModelAdaptation();
	const body = { model: "gpt-4o-mini", temperature: 0.3 };
	adaptation.learn(
		chatTarget,
		body,
		"temperature is not supported with this model",
	);
	const other = { ...chatTarget, baseUrl: "https://other.test/v1" };
	expect(adaptation.adjust(other, body)).toHaveProperty("temperature", 0.3);
});

test("learning refuses params the request did not send, and Anthropic max_tokens", () => {
	const adaptation = new ModelAdaptation();
	expect(
		adaptation.learn(
			chatTarget,
			{ model: "x" },
			"Unsupported parameter: 'top_p'",
		),
	).toBeNull();
	const anthropic = {
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		baseUrl: "https://a.test",
	} as const;
	expect(
		adaptation.learn(
			anthropic,
			{ max_tokens: 5 },
			"Unsupported parameter: 'max_tokens'",
		),
	).toBeNull();
});

test("a learned max_tokens rejection renames it on Chat Completions", () => {
	const adaptation = new ModelAdaptation();
	const body = { model: "gpt-4o-mini", max_tokens: 128 };
	expect(
		adaptation.learn(
			chatTarget,
			body,
			"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
		),
	).toBe("max_tokens");
	expect(adaptation.adjust(chatTarget, body)).toEqual({
		model: "gpt-4o-mini",
		max_completion_tokens: 128,
	});
});
