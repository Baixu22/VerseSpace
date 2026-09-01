/**
 * stream-json → per-lane usage samples (R3 / TF-0084).
 *
 * Every competitor in this space shows a fill percentage — "73% of context
 * used" — which tells you how close you are to a wall and nothing about what
 * the wall is made of. A percentage hides the two numbers that actually
 * differ between lanes: how many tokens the lane burned in absolute terms,
 * and how much of its input the cache absorbed.
 *
 * So this module pulls absolute counts out of the `usage` object, keeps the
 * cache split three ways (created / read / fresh input), and counts the two
 * things percentages erase entirely: how many times the lane was compacted,
 * and how much of what it saw came back from tools.
 *
 * Pure and total: an unrecognized line yields null. Capture never blocks on
 * this, and a CLI that changes its field names degrades to "no data" rather
 * than to a wrong number.
 */

export interface UsageSample {
	/** Fresh input tokens — the ones the cache did not absorb. */
	inputTokens: number;
	outputTokens: number;
	/** Tokens written into the cache this turn (a miss that will recur). */
	cacheCreationTokens: number;
	/** Tokens served from the cache this turn (a hit). */
	cacheReadTokens: number;
	toolCalls: number;
	toolResultBytes: number;
	assistantTextBytes: number;
	/** The lane was compacted — context was thrown away and rebuilt. */
	compaction: boolean;
	/** The turn ended in an error (drives the consecutive-failure counter). */
	failed: boolean;
}

export function emptyUsage(): UsageSample {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheCreationTokens: 0,
		cacheReadTokens: 0,
		toolCalls: 0,
		toolResultBytes: 0,
		assistantTextBytes: 0,
		compaction: false,
		failed: false,
	};
}

function num(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function bytesOf(value: unknown): number {
	if (typeof value === "string") {
		return value.length;
	}
	if (Array.isArray(value)) {
		// tool_result content is either a string or a list of typed blocks
		return value.reduce((sum, block) => {
			const b = block as { text?: unknown; content?: unknown };
			return (
				sum +
				(typeof b.text === "string" ? b.text.length : 0) +
				bytesOf(b.content)
			);
		}, 0);
	}
	return 0;
}

export function extractUsage(
	event: Record<string, unknown>,
): UsageSample | null {
	const type = event.type;

	if (type === "system" && event.subtype === "compact_boundary") {
		return { ...emptyUsage(), compaction: true };
	}

	if (type === "result") {
		const usage = (event.usage ?? {}) as Record<string, unknown>;
		const failed =
			event.is_error === true ||
			(typeof event.subtype === "string" &&
				event.subtype !== "success" &&
				event.subtype.startsWith("error"));
		return {
			inputTokens: num(usage.input_tokens),
			outputTokens: num(usage.output_tokens),
			cacheCreationTokens: num(usage.cache_creation_input_tokens),
			cacheReadTokens: num(usage.cache_read_input_tokens),
			toolCalls: 0,
			toolResultBytes: 0,
			assistantTextBytes: 0,
			compaction: false,
			failed,
		};
	}

	if (type === "assistant") {
		const message = (event.message ?? {}) as Record<string, unknown>;
		const usage = (message.usage ?? {}) as Record<string, unknown>;
		const content = Array.isArray(message.content) ? message.content : [];
		let toolCalls = 0;
		let assistantTextBytes = 0;
		for (const block of content as Array<Record<string, unknown>>) {
			if (block.type === "tool_use") {
				toolCalls += 1;
			} else if (block.type === "text") {
				assistantTextBytes += bytesOf(block.text);
			}
		}
		const sample: UsageSample = {
			inputTokens: num(usage.input_tokens),
			outputTokens: num(usage.output_tokens),
			cacheCreationTokens: num(usage.cache_creation_input_tokens),
			cacheReadTokens: num(usage.cache_read_input_tokens),
			toolCalls,
			toolResultBytes: 0,
			assistantTextBytes,
			compaction: false,
			failed: false,
		};
		const empty =
			sample.inputTokens +
				sample.outputTokens +
				sample.cacheCreationTokens +
				sample.cacheReadTokens +
				sample.toolCalls +
				sample.assistantTextBytes ===
			0;
		return empty ? null : sample;
	}

	if (type === "user") {
		const message = (event.message ?? {}) as Record<string, unknown>;
		const content = Array.isArray(message.content) ? message.content : [];
		let toolCalls = 0;
		let toolResultBytes = 0;
		for (const block of content as Array<Record<string, unknown>>) {
			if (block.type === "tool_result") {
				toolCalls += 1;
				toolResultBytes += bytesOf(block.content);
			}
		}
		if (toolCalls === 0) {
			return null;
		}
		return { ...emptyUsage(), toolCalls, toolResultBytes };
	}

	return null;
}

/** Add one sample into a running total, in place. */
export function accumulate(
	total: UsageSample,
	sample: UsageSample,
): UsageSample {
	return {
		inputTokens: total.inputTokens + sample.inputTokens,
		outputTokens: total.outputTokens + sample.outputTokens,
		cacheCreationTokens: total.cacheCreationTokens + sample.cacheCreationTokens,
		cacheReadTokens: total.cacheReadTokens + sample.cacheReadTokens,
		toolCalls: total.toolCalls + sample.toolCalls,
		toolResultBytes: total.toolResultBytes + sample.toolResultBytes,
		assistantTextBytes: total.assistantTextBytes + sample.assistantTextBytes,
		compaction: total.compaction || sample.compaction,
		failed: sample.failed,
	};
}
