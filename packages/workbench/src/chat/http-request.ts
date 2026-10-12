import type { WorkbenchConfig } from "../types/config";

import { httpEndpoint } from "./http-endpoint";

/** Defaults per HTTP provider. Shared by the request builder and the target planner. */
export const HTTP_PROVIDER_DEFAULTS = {
	anthropic: {
		model: "claude-sonnet-4-5",
		baseUrl: "https://api.anthropic.com",
	},
	"openai-chat": {
		model: "gpt-4o-mini",
		baseUrl: "https://api.openai.com/v1",
	},
	"openai-responses": {
		model: "gpt-4o-mini",
		baseUrl: "https://api.openai.com/v1",
	},
} as const;

/**
 * TF-0204: the `provider === "…"` comparisons in this file (and in
 * `http-stream.ts` / `http-run.ts`) are deliberately NOT part of the
 * capabilities table. They choose a wire format — which request body to send
 * and which response shape to parse — and two providers that differ here can
 * still be identical on every capability. Moving them into the table would
 * make it "everything we know about a provider", which is the shape that rots;
 * a capability belongs there only when a *behaviour* branches on it.
 */
export function buildHttpRequest(
	provider: WorkbenchConfig["chat"]["provider"],
	key: string,
	chat: WorkbenchConfig["chat"],
	history: Array<{ role: string; content: string }>,
	/**
	 * Stable per-thread key. It routes same-thread requests to the same prompt
	 * cache (OpenAI `prompt_cache_key`) and is the stable identity for the
	 * thread's cache on the other lanes. Omitted = no cache hint is sent.
	 */
	cacheKey?: string,
): {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
} {
	let url: string;
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	const body: Record<string, unknown> = {};

	if (provider === "anthropic") {
		url = httpEndpoint(
			chat.baseUrl ?? HTTP_PROVIDER_DEFAULTS.anthropic.baseUrl,
			"/v1/messages",
		);
		headers["x-api-key"] = key;
		headers["anthropic-version"] = "2023-06-01";
		body.model = chat.model ?? HTTP_PROVIDER_DEFAULTS.anthropic.model;
		body.max_tokens = chat.maxTokens ?? 1024;
		if (chat.temperature !== undefined) {
			body.temperature = chat.temperature;
		}
		body.stream = true;
		body.messages = history;
		// Automatic prompt caching: the breakpoint moves to the last cacheable
		// block as the conversation grows, so no per-message markers are needed.
		body.cache_control = { type: "ephemeral" };
	} else if (provider === "openai-chat") {
		url = httpEndpoint(
			chat.baseUrl ?? HTTP_PROVIDER_DEFAULTS["openai-chat"].baseUrl,
			"/chat/completions",
		);
		headers.authorization = `Bearer ${key}`;
		body.model = chat.model ?? HTTP_PROVIDER_DEFAULTS["openai-chat"].model;
		body.messages = history;
		body.stream = true;
		if (cacheKey) body.prompt_cache_key = cacheKey;
		if (chat.temperature !== undefined) {
			body.temperature = chat.temperature;
		}
		if (chat.maxTokens !== undefined) {
			body.max_tokens = chat.maxTokens;
		}
	} else {
		// openai-responses
		url = httpEndpoint(
			chat.baseUrl ?? HTTP_PROVIDER_DEFAULTS["openai-responses"].baseUrl,
			"/responses",
		);
		headers.authorization = `Bearer ${key}`;
		body.model = chat.model ?? HTTP_PROVIDER_DEFAULTS["openai-responses"].model;
		body.input = history.map((m) => ({ role: m.role, content: m.content }));
		body.stream = true;
		if (cacheKey) body.prompt_cache_key = cacheKey;
		if (chat.temperature !== undefined) {
			body.temperature = chat.temperature;
		}
		if (chat.maxTokens !== undefined) {
			body.max_output_tokens = chat.maxTokens;
		}
		if (chat.effort) {
			body.reasoning = { effort: chat.effort };
		}
	}
	return { url, headers, body };
}
