/**
 * Per-model request adaptation for the HTTP lane.
 *
 * Two sources, applied in order to every request body:
 *
 * 1. **Declared** — rules we know before the first call. Reasoning-class
 *    OpenAI models (o-series, gpt-5 except `-chat`) reject a non-default
 *    `temperature` / `top_p` and want `max_completion_tokens` instead of
 *    `max_tokens` on Chat Completions.
 * 2. **Learned** — when an upstream answers 400 and names a parameter it does
 *    not accept, that parameter is dropped (or renamed) for this
 *    provider+model+endpoint and the request is retried once. This mirrors
 *    LiteLLM's `drop_params` / per-deployment `additional_drop_params`: the
 *    adaptation is written down, not hard-coded per error string.
 *
 * Only parameters in `ADAPTABLE_PARAMS` can ever be dropped. Required fields
 * (`model`, `messages`, `input`, Anthropic `max_tokens`, `stream`) are never
 * touched, so a misleading error cannot strip what the request needs.
 */

import type { HttpProvider } from "./protocols";

export const ADAPTABLE_PARAMS = [
	"temperature",
	"top_p",
	"max_tokens",
	"presence_penalty",
	"frequency_penalty",
	"prompt_cache_key",
	"cache_control",
	"stream_options",
] as const;

export type AdaptableParam = (typeof ADAPTABLE_PARAMS)[number];

export interface AdaptationTarget {
	provider: HttpProvider;
	model: string;
	/** Endpoint identity: the same model behind two gateways may differ. */
	baseUrl: string;
}

const RENAMES: Partial<Record<AdaptableParam, string>> = {
	// OpenAI reasoning models on Chat Completions only accept this name.
	max_tokens: "max_completion_tokens",
};

const ADAPTABLE_SET = new Set<string>(ADAPTABLE_PARAMS);

/** o1/o3/o4-style reasoning models and gpt-5 (but not the `-chat` variant). */
export function isOpenAiReasoningModel(model: string): boolean {
	const name = model.trim().toLowerCase();
	return /^o\d/.test(name) || /^gpt-5(?!-chat)/.test(name);
}

function keyOf(target: AdaptationTarget): string {
	return `${target.provider}\u0000${target.model}\u0000${target.baseUrl}`;
}

/**
 * Pull the offending parameter name out of an upstream error message.
 * Covers the phrasings seen from OpenAI, Azure, Anthropic-compatible gateways
 * and LiteLLM-style proxies. Returns null when the message does not name an
 * adaptable parameter — an unknown complaint is never guessed at.
 */
export function parseRejectedParam(message: string): AdaptableParam | null {
	const patterns: RegExp[] = [
		// "Unsupported parameter: 'max_tokens' is not supported with this model"
		/unsupported (?:parameter|argument|field)s?:?\s*['"`]?([a-z_]+)/i,
		// "Unknown parameter: 'prompt_cache_key'" / "Unrecognized request argument supplied: cache_control"
		/unknown (?:parameter|argument|field)s?:?\s*['"`]?([a-z_]+)/i,
		/unrecognized request arguments?(?: supplied)?:?\s*['"`]?([a-z_]+)/i,
		// "Unsupported value: 'temperature' does not support 0.2 with this model"
		/['"`]([a-z_]+)['"`] does not support/i,
		// "temperature is not supported with this model"
		/\b([a-z_]+) (?:is|are) not supported/i,
		// "gpt-5 models don't support temperature=0.3"
		/don'?t support ([a-z_]+)=/i,
	];
	for (const pattern of patterns) {
		const hit = pattern.exec(message)?.[1]?.toLowerCase();
		if (hit && ADAPTABLE_SET.has(hit)) return hit as AdaptableParam;
	}
	return null;
}

/** Stateless per-process memory of what each endpoint has rejected. */
export class ModelAdaptation {
	private readonly dropped = new Map<string, Set<AdaptableParam>>();

	/** Applies declared rules, then anything already learned for this target. */
	adjust(
		target: AdaptationTarget,
		body: Record<string, unknown>,
	): Record<string, unknown> {
		const next: Record<string, unknown> = { ...body };
		const learned = this.dropped.get(keyOf(target)) ?? new Set();
		for (const param of declaredDrops(target)) {
			learned.add(param);
		}
		for (const param of learned) {
			applyParam(target, next, param);
		}
		return next;
	}

	/**
	 * Record a rejection. Returns the parameter that was learned, or null when
	 * the message is not an adaptable complaint about a parameter the request
	 * actually sent (so the caller does not loop on the same error).
	 */
	learn(
		target: AdaptationTarget,
		body: Record<string, unknown>,
		message: string,
	): AdaptableParam | null {
		const param = parseRejectedParam(message);
		if (!param || !(param in body)) return null;
		// Required on Anthropic: there is no alternative spelling to fall back to.
		if (param === "max_tokens" && target.provider === "anthropic") return null;
		const key = keyOf(target);
		const set = this.dropped.get(key) ?? new Set<AdaptableParam>();
		if (set.has(param)) return null;
		set.add(param);
		this.dropped.set(key, set);
		return param;
	}

	/** For tests and diagnostics: what has been learned for a target. */
	learnedFor(target: AdaptationTarget): AdaptableParam[] {
		return [...(this.dropped.get(keyOf(target)) ?? [])];
	}
}

function declaredDrops(target: AdaptationTarget): AdaptableParam[] {
	if (
		target.provider === "anthropic" ||
		!isOpenAiReasoningModel(target.model)
	) {
		return [];
	}
	return ["temperature", "top_p", "max_tokens"];
}

function applyParam(
	target: AdaptationTarget,
	body: Record<string, unknown>,
	param: AdaptableParam,
): void {
	if (!(param in body)) return;
	const renamed = RENAMES[param];
	// Chat Completions renames max_tokens; Responses and Anthropic do not.
	// Renaming is only learned from an endpoint that rejected the old name.
	if (renamed && target.provider === "openai-chat") {
		body[renamed] = body[param];
	}
	delete body[param];
}
