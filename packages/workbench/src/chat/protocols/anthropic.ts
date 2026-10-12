import {
	asNumber,
	asRecord,
	asString,
	classifyFailure,
	parseJsonRecord,
} from "./errors.ts";
import type { FailureKind, ParsedFrame, ProtocolCodec } from "./types.ts";

/** Anthropic error `type` values are more reliable than their message text. */
const ANTHROPIC_ERROR_TYPES: Record<string, FailureKind> = {
	overloaded_error: "overloaded",
	rate_limit_error: "rate",
	api_error: "server",
	authentication_error: "auth",
	permission_error: "auth",
	not_found_error: "model_missing",
	billing_error: "quota",
};

export const anthropicCodec: ProtocolCodec = {
	provider: "anthropic",
	defaultModel: "claude-sonnet-4-5",
	defaultBaseUrl: "https://api.anthropic.com",
	path: () => "/v1/messages",
	query: () => ({}),
	headers: (key) => ({
		"content-type": "application/json",
		"x-api-key": key,
		"anthropic-version": "2023-06-01",
	}),
	body(request) {
		const body: Record<string, unknown> = {
			model: request.model,
			// Required by the protocol: there is no default.
			max_tokens: request.maxTokens ?? 1024,
			messages: request.turns,
			stream: true,
			// Automatic caching: the breakpoint follows the last cacheable block
			// as the conversation grows, so no per-message markers are needed.
			// Long sessions get the 1-hour TTL (2x write price): idle gaps longer
			// than five minutes would otherwise expire the prefix every time.
			cache_control: request.longSession
				? { type: "ephemeral", ttl: "1h" }
				: { type: "ephemeral" },
		};
		if (request.system) body.system = request.system;
		if (request.temperature !== undefined)
			body.temperature = request.temperature;
		return body;
	},
	parse(payload) {
		if (payload === "[DONE]") return [{ terminal: true }];
		const event = parseJsonRecord(payload);
		if (!event) return [{ malformed: true }];

		switch (event.type) {
			case "message_start": {
				const usage = asRecord(asRecord(event.message)?.usage);
				if (!usage) return [{}];
				const uncached = asNumber(usage.input_tokens);
				const read = asNumber(usage.cache_read_input_tokens);
				const written = asNumber(usage.cache_creation_input_tokens);
				// Anthropic reports input_tokens exclusive of cache reads and writes.
				// Sum them so promptTokens means the same thing as on OpenAI.
				const promptTokens =
					uncached === undefined
						? undefined
						: uncached + (read ?? 0) + (written ?? 0);
				return [
					{
						usage: {
							promptTokens,
							cachedTokens: read,
							cacheWriteTokens: written,
							outputTokens: asNumber(usage.output_tokens),
						},
					},
				];
			}
			case "content_block_delta": {
				const delta = asRecord(event.delta);
				const text =
					delta?.type === "text_delta" ? asString(delta.text) : undefined;
				return text ? [{ text }] : [{}];
			}
			case "message_delta": {
				const frame: ParsedFrame = {};
				const usage = asRecord(event.usage);
				const outputTokens = asNumber(usage?.output_tokens);
				if (outputTokens !== undefined) frame.usage = { outputTokens };
				if (asString(asRecord(event.delta)?.stop_reason) === "refusal") {
					return [
						{
							error: {
								kind: "content_filter",
								message: "上游因安全策略拒绝回答",
							},
						},
					];
				}
				return [frame];
			}
			case "message_stop":
				return [{ terminal: true }];
			case "error": {
				const err = asRecord(event.error);
				const message = asString(err?.message) ?? "anthropic stream error";
				const type = asString(err?.type) ?? "";
				const kind =
					ANTHROPIC_ERROR_TYPES[type] ?? classifyFailure({ message, type });
				return [{ error: { kind, message } }];
			}
			default:
				// ping, content_block_start/stop and unknown future events carry nothing we need.
				return [{}];
		}
	},
};
