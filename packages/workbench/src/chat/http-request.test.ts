import { expect, test } from "bun:test";
import { buildHttpRequest } from "./http-request";

const history = [{ role: "user", content: "你好" }];

test("Responses carries the thread cache key only when one is given", () => {
	const chat = {
		provider: "openai-responses",
		model: "gpt-4o-mini",
		noticeTokenBudget: 300,
	} as never;
	const keyed = buildHttpRequest(
		"openai-responses",
		"k",
		chat,
		history,
		"thread-1",
	);
	expect(keyed.body.prompt_cache_key).toBe("thread-1");
	const bare = buildHttpRequest("openai-responses", "k", chat, history);
	expect(bare.body).not.toHaveProperty("prompt_cache_key");
});

test("Anthropic opts into automatic top-level caching", () => {
	const chat = { provider: "anthropic", noticeTokenBudget: 300 } as never;
	const { body, url, headers } = buildHttpRequest(
		"anthropic",
		"k",
		chat,
		history,
		"t",
	);
	expect(body.cache_control).toEqual({ type: "ephemeral" });
	expect(url).toBe("https://api.anthropic.com/v1/messages");
	expect(headers["anthropic-version"]).toBe("2023-06-01");
});

test("Chat Completions defaults are unchanged apart from the cache key", () => {
	const chat = { provider: "openai-chat", noticeTokenBudget: 300 } as never;
	const keyed = buildHttpRequest("openai-chat", "k", chat, history, "t");
	expect(keyed.url).toBe("https://api.openai.com/v1/chat/completions");
	expect(keyed.body).toMatchObject({
		model: "gpt-4o-mini",
		stream: true,
		messages: history,
	});
	expect(keyed.body.prompt_cache_key).toBe("t");
	const bare = buildHttpRequest("openai-chat", "k", chat, history);
	expect(bare.body).not.toHaveProperty("prompt_cache_key");
});

test("Gemini is reached through its OpenAI-compatible endpoint on the Chat Completions lane", () => {
	const chat = {
		provider: "openai-chat",
		model: "gemini-2.5-flash",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		noticeTokenBudget: 300,
	} as never;
	const { url, body } = buildHttpRequest(
		"openai-chat",
		"k",
		chat,
		history,
		"t",
	);
	expect(url).toBe(
		"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
	);
	expect(body.model).toBe("gemini-2.5-flash");
	expect(body.stream_options).toEqual({ include_usage: true });
});

test("Anthropic switches to the 1-hour TTL only for long sessions", () => {
	const chat = {
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		noticeTokenBudget: 300,
	} as never;
	const short = buildHttpRequest("anthropic", "k", chat, history).body;
	expect(short.cache_control).toEqual({ type: "ephemeral" });
	const long = Array.from({ length: 20 }, (_, i) => ({
		role: i % 2 === 0 ? "user" : "assistant",
		content: `第 ${i} 条`,
	}));
	const longBody = buildHttpRequest("anthropic", "k", chat, long).body;
	expect(longBody.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
});
