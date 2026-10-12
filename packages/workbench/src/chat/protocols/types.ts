/**
 * Canonical contract for every HTTP protocol codec.
 *
 * A codec is the only place that knows a protocol's wire shape. The lane
 * (http-run) speaks only in these types: a request description going out, and
 * normalised frames coming back. Adding a protocol means adding one codec, not
 * touching the retry, failover, or cache code.
 */

export type HttpProvider = "openai-chat" | "openai-responses" | "anthropic";

export interface CodecTurn {
	role: string;
	content: string;
}

export interface CodecRequest {
	model: string;
	turns: CodecTurn[];
	system?: string;
	maxTokens?: number;
	temperature?: number;
	effort?: "low" | "medium" | "high";
	/**
	 * The thread is long enough that reuse is likely across idle gaps. Only
	 * Anthropic reads this: it switches automatic caching to the 1-hour TTL.
	 */
	longSession?: boolean;
	/** Stable per-thread key; codecs without a cache hint ignore it. */
	cacheKey?: string;
}

/** Why an upstream failed, in terms the policy can act on. */
export type FailureKind =
	// account or billing exhausted: retrying the same target is pointless
	| "quota"
	// throttled: retry after a pause
	| "rate"
	// upstream busy (529 / overloaded_error): retry
	| "overloaded"
	// 5xx / internal: retry
	| "server"
	// no response or no data within the idle budget: retry
	| "timeout"
	// connection failed before any HTTP answer: retry
	| "network"
	// stream cut or in-stream transient error: retry
	| "stream"
	// bad or forbidden key: switch target
	| "auth"
	// model not available on this endpoint: switch target
	| "model_missing"
	// prompt too long for this model: switch to a larger one
	| "context_overflow"
	// refused by policy: no target will change the answer
	| "content_filter"
	// malformed request: adapt if possible, otherwise fail
	| "bad_request"
	// unparseable frame: fail
	| "malformed";

export interface StreamError {
	kind: FailureKind;
	message: string;
}

/** Token usage as reported by one frame. Every field is optional: frames split it. */
export interface UsagePatch {
	/** Total prompt tokens, including any that were served from cache. */
	promptTokens?: number;
	/** Prompt tokens read from cache (cache hit). */
	cachedTokens?: number;
	/** Prompt tokens written to cache on this request (Anthropic, GPT-5.6+). */
	cacheWriteTokens?: number;
	outputTokens?: number;
}

export interface ParsedFrame {
	text?: string;
	usage?: UsagePatch;
	/** The provider has finished the answer normally. */
	terminal?: boolean;
	error?: StreamError;
	/** The payload could not be parsed; the stream cannot be trusted. */
	malformed?: boolean;
}

export interface ProtocolCodec {
	readonly provider: HttpProvider;
	readonly defaultModel: string;
	readonly defaultBaseUrl: string;
	/** Path relative to the base URL; the model may be part of it. */
	path(model: string): string;
	/** Extra query parameters; Gemini needs `alt=sse` to stream. */
	query(): Record<string, string>;
	headers(key: string): Record<string, string>;
	body(request: CodecRequest): Record<string, unknown>;
	/** One SSE `data:` payload, already stripped of the prefix. */
	parse(payload: string): ParsedFrame[];
}

export interface TurnUsage {
	promptTokens: number;
	cachedTokens: number;
	cacheWriteTokens: number;
	outputTokens: number;
}

/** Per-field override merge: later frames win, undefined never erases a value. */
export function mergeUsage(
	acc: UsagePatch | undefined,
	patch: UsagePatch | undefined,
): UsagePatch | undefined {
	if (!patch) return acc;
	const next: UsagePatch = { ...(acc ?? {}) };
	for (const key of Object.keys(patch) as Array<keyof UsagePatch>) {
		const value = patch[key];
		if (typeof value === "number" && Number.isFinite(value)) {
			next[key] = value;
		}
	}
	return next;
}

/** A usage record is only reported when the provider actually sent prompt counts. */
export function finalizeUsage(
	patch: UsagePatch | undefined,
): TurnUsage | undefined {
	if (!patch || patch.promptTokens === undefined) return undefined;
	return {
		promptTokens: patch.promptTokens,
		cachedTokens: Math.min(patch.cachedTokens ?? 0, patch.promptTokens),
		cacheWriteTokens: patch.cacheWriteTokens ?? 0,
		outputTokens: patch.outputTokens ?? 0,
	};
}

/** Share of the prompt served from cache, or null when there was no prompt. */
export function cacheHitRatio(usage: TurnUsage): number | null {
	if (usage.promptTokens <= 0) return null;
	return usage.cachedTokens / usage.promptTokens;
}
