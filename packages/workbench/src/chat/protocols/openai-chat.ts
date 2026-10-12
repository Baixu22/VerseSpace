import {
	asNumber,
	asRecord,
	asString,
	classifyFailure,
	parseJsonRecord,
} from "./errors.ts";
import type { ParsedFrame, ProtocolCodec } from "./types.ts";

/** OpenAI Chat Completions (and every compatible gateway that speaks it). */
export const openAiChatCodec: ProtocolCodec = {
	provider: "openai-chat",
	defaultModel: "gpt-4o-mini",
	defaultBaseUrl: "https://api.openai.com/v1",
	path: () => "/chat/completions",
	query: () => ({}),
	headers: (key) => ({
		"content-type": "application/json",
		authorization: `Bearer ${key}`,
	}),
	body(request) {
		const messages = request.system
			? [{ role: "system", content: request.system }, ...request.turns]
			: request.turns;
		const body: Record<string, unknown> = {
			model: request.model,
			messages,
			stream: true,
			// Usage arrives in a final chunk only when asked for. Without it the
			// cache hit rate cannot be observed at all.
			stream_options: { include_usage: true },
		};
		if (request.cacheKey) body.prompt_cache_key = request.cacheKey;
		if (request.temperature !== undefined)
			body.temperature = request.temperature;
		if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
		return body;
	},
	parse(payload) {
		if (payload === "[DONE]") return [{ terminal: true }];
		const event = parseJsonRecord(payload);
		if (!event) return [{ malformed: true }];

		const err = asRecord(event.error);
		if (err || event.type === "error") {
			const message =
				asString(err?.message) ??
				asString(event.message) ??
				"openai stream error";
			return [
				{
					error: {
						kind: classifyFailure({
							message,
							code: asString(err?.code),
							type: asString(err?.type),
						}),
						message,
					},
				},
			];
		}

		const choices = Array.isArray(event.choices) ? event.choices : [];
		const choice = asRecord(choices[0]);
		const frame: ParsedFrame = {};
		const delta = asString(asRecord(choice?.delta)?.content);
		if (delta) frame.text = delta;

		const finish = asString(choice?.finish_reason);
		if (finish === "content_filter") {
			return [
				{
					error: {
						kind: "content_filter",
						message: "上游因内容策略中止了回答",
					},
				},
			];
		}
		if (finish) frame.terminal = true;

		const usage = asRecord(event.usage);
		if (usage) {
			frame.usage = {
				promptTokens: asNumber(usage.prompt_tokens),
				outputTokens: asNumber(usage.completion_tokens),
				cachedTokens: asNumber(
					asRecord(usage.prompt_tokens_details)?.cached_tokens,
				),
			};
		}
		return [frame];
	},
};
