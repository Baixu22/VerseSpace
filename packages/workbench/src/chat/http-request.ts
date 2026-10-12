import type { WorkbenchConfig } from "../types/config";

import { httpEndpoint } from "./http-endpoint";
import { codecFor, type HttpProvider } from "./protocols";

/**
 * Defaults per HTTP provider, read from each protocol codec. Shared by the
 * request builder and the target planner.
 */
export const HTTP_PROVIDER_DEFAULTS: Record<
	HttpProvider,
	{ model: string; baseUrl: string }
> = {
	anthropic: {
		model: codecFor("anthropic").defaultModel,
		baseUrl: codecFor("anthropic").defaultBaseUrl,
	},
	"openai-chat": {
		model: codecFor("openai-chat").defaultModel,
		baseUrl: codecFor("openai-chat").defaultBaseUrl,
	},
	"openai-responses": {
		model: codecFor("openai-responses").defaultModel,
		baseUrl: codecFor("openai-responses").defaultBaseUrl,
	},
};

/**
 * Builds the endpoint, headers and body for one HTTP target. Wire-format
 * knowledge lives in the codec for that protocol; this function only resolves
 * the target's model and endpoint.
 *
 * TF-0204: the wire format is a protocol property, not a capability, so it is
 * kept out of the capabilities table.
 */
export function buildHttpRequest(
	provider: HttpProvider,
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
	const codec = codecFor(provider);
	const baseUrl = chat.baseUrl ?? codec.defaultBaseUrl;
	const query = new URLSearchParams(codec.query()).toString();
	const url =
		httpEndpoint(baseUrl, codec.path(chat.model ?? codec.defaultModel)) +
		(query ? `?${query}` : "");
	return {
		url,
		headers: codec.headers(key),
		body: codec.body({
			model: chat.model ?? codec.defaultModel,
			turns: history.map((m) => ({ role: m.role, content: m.content })),
			maxTokens: chat.maxTokens,
			temperature: chat.temperature,
			effort: chat.effort,
			cacheKey,
		}),
	};
}
