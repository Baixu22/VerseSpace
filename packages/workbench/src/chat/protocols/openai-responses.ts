import {
	asNumber,
	asRecord,
	asString,
	classifyFailure,
	parseJsonRecord,
} from "./errors.ts";
import type { ParsedFrame, ProtocolCodec } from "./types.ts";

/**
 * OpenAI Responses API.
 *
 * Server-side storage is allowed (`store: true`, the provider default made
 * explicit). Storage is what lets a later turn reuse `previous_response_id`.
 */
export const openAiResponsesCodec: ProtocolCodec = {
	provider: "openai-responses",
	defaultModel: "gpt-4o-mini",
	defaultBaseUrl: "https://api.openai.com/v1",
	path: () => "/responses",
	query: () => ({}),
	headers: (key) => ({
		"content-type": "application/json",
		authorization: `Bearer ${key}`,
	}),
	body(request) {
		const body: Record<string, unknown> = {
			model: request.model,
			input: request.turns,
			stream: true,
			store: true,
		};
		if (request.system) body.instructions = request.system;
		if (request.cacheKey) body.prompt_cache_key = request.cacheKey;
		if (request.temperature !== undefined)
			body.temperature = request.temperature;
		if (request.maxTokens !== undefined)
			body.max_output_tokens = request.maxTokens;
		if (request.effort) body.reasoning = { effort: request.effort };
		return body;
	},
	parse(payload) {
		if (payload === "[DONE]") return [{ terminal: true }];
		const event = parseJsonRecord(payload);
		if (!event) return [{ malformed: true }];

		switch (event.type) {
			case "response.output_text.delta": {
				const text = asString(event.delta);
				return text ? [{ text }] : [{}];
			}
			case "response.completed":
			case "response.done":
			case "response.incomplete": {
				const response = asRecord(event.response);
				const reason = asString(asRecord(response?.incomplete_details)?.reason);
				const usage = asRecord(response?.usage);
				const frame: ParsedFrame = {
					usage: usage
						? {
								promptTokens: asNumber(usage.input_tokens),
								outputTokens: asNumber(usage.output_tokens),
								cachedTokens: asNumber(
									asRecord(usage.input_tokens_details)?.cached_tokens,
								),
							}
						: undefined,
				};
				if (reason === "content_filter") {
					return [
						{
							error: {
								kind: "content_filter",
								message: "上游因内容策略中止了回答",
							},
						},
					];
				}
				// A max_output_tokens stop is a normal, complete-but-truncated answer.
				frame.terminal = true;
				return [frame];
			}
			case "response.failed":
			case "error": {
				const response = asRecord(event.response);
				const err = asRecord(response?.error) ?? asRecord(event.error) ?? event;
				const message =
					asString(err.message) ?? asString(event.message) ?? "responses error";
				return [
					{
						error: {
							kind: classifyFailure({
								message,
								code: asString(err.code),
								type: asString(err.type),
							}),
							message,
						},
					},
				];
			}
			default:
				return [{}];
		}
	},
};
