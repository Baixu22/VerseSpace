import type { FailureKind } from "./types.ts";

/**
 * Map an upstream failure to a FailureKind.
 *
 * Message text is checked before the status code, because providers reuse
 * 429 and 400 for very different problems: a 429 that says "insufficient_quota"
 * is not a rate limit, and a 400 that says "context_length_exceeded" is not a
 * malformed request. Patterns are ordered from most to least specific.
 */
export function classifyFailure(input: {
	status?: number;
	message?: string;
	code?: string;
	type?: string;
}): FailureKind {
	const text = [input.code, input.type, input.message]
		.filter((part): part is string => typeof part === "string" && part !== "")
		.join(" ");

	if (
		/insufficient[_ ]quota|exceeded (your )?(current )?quota|billing|credit balance|out of credits|payment required/i.test(
			text,
		)
	) {
		return "quota";
	}
	if (
		/context[_ ](length|window)|maximum context|too many tokens|prompt is too long|input is too long|exceeds the (model'?s )?(maximum )?context/i.test(
			text,
		)
	) {
		return "context_overflow";
	}
	if (
		/content[_ ]filter|content policy|PROHIBITED_CONTENT|SAFETY|blocklist|RECITATION/i.test(
			text,
		)
	) {
		return "content_filter";
	}
	if (
		/model[^.]{0,40}(not found|does not exist|not available|unknown|unsupported)|no such model|unsupported model|NOT_FOUND/i.test(
			text,
		)
	) {
		return "model_missing";
	}
	if (/overloaded/i.test(text)) {
		return "overloaded";
	}
	if (/rate[_ ]limit|too many requests/i.test(text)) {
		return "rate";
	}
	if (
		/unauthenticated|invalid[_ ]api[_ ]key|authentication|permission[_ ]denied|forbidden/i.test(
			text,
		)
	) {
		return "auth";
	}

	return kindFromStatus(input.status);
}

export function kindFromStatus(status: number | undefined): FailureKind {
	if (status === undefined) return "bad_request";
	if (status === 401 || status === 403) return "auth";
	if (status === 404) return "model_missing";
	if (status === 408) return "timeout";
	if (status === 429) return "rate";
	if (status === 529) return "overloaded";
	if (status >= 500) return "server";
	return "bad_request";
}

/** Parse a JSON payload; `undefined` means the payload is not usable JSON. */
export function parseJsonRecord(
	payload: string,
): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(payload);
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
