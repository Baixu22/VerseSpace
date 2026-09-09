/** Goal extraction and file-state checks for the live-agent loop.
 * When the user prompt embeds a WRITE directive, the goal is the on-disk
 * file state, not whether the model chose to stop calling tools. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface LiveGoal {
	readonly path: string;
	readonly expected: string;
}

export interface LiveReadSpan {
	readonly path: string;
	readonly offset: number;
	readonly limit: number;
}

const WRITE_DIRECTIVE =
	/(?:^|\n)WRITE[ \t]+(src\/[A-Za-z0-9_.\/-]+)[ \t]*\r?\n([\s\S]*?)\r?\n?__END_WRITE__/;
const READSPAN_DIRECTIVE =
	/(?:^|\n)READSPAN[ \t]+(src\/[A-Za-z0-9_.\/-]+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*(?:\r?\n|$)/g;

/** Parse the WRITE literal embedded in a live-agent user prompt, if any. */
export function goalFromUserText(text: string): LiveGoal | null {
	const match = WRITE_DIRECTIVE.exec(text);
	if (!match) return null;
	const [, path, expected] = match;
	if (!path || expected === undefined) return null;
	return { path, expected };
}

/**
 * Whether the file under `root` currently matches the goal. Resolves relative
 * to root exactly the way executeLiveTool does for src/ paths; returns false
 * on missing/unreadable files instead of throwing so the caller can keep
 * the loop running.
 */
/** Parse READSPAN directives so live-agent can force offset/limit onto Read calls. */
export function spansFromUserText(text: string): LiveReadSpan[] {
	const spans: LiveReadSpan[] = [];
	for (const match of text.matchAll(READSPAN_DIRECTIVE)) {
		const path = match[1];
		const offset = Number(match[2]);
		const limit = Number(match[3]);
		if (!path || !Number.isInteger(offset) || !Number.isInteger(limit)) continue;
		if (offset < 1 || limit < 1) continue;
		spans.push({ path, offset, limit });
	}
	return spans;
}

/**
 * If this Read targets a path that the user asked to READSPAN, attach that
 * offset/limit. Full-file reads of a spanned path would otherwise claim the
 * whole file and turn later out-of-span appends into false stale premises.
 */
export function applyReadSpan(
	toolName: string,
	raw: unknown,
	spans: readonly LiveReadSpan[],
): unknown {
	if (toolName !== "Read" || !spans.length || raw === null || typeof raw !== "object")
		return raw;
	const args = raw as Record<string, unknown>;
	const filePath = typeof args.file_path === "string" ? args.file_path.replace(/\\/g, "/") : "";
	const span = spans.find((item) => item.path === filePath);
	if (!span) return raw;
	return { ...args, offset: span.offset, limit: span.limit };
}

export async function goalMet(root: string, goal: LiveGoal): Promise<boolean> {
	try {
		const absolute = resolve(root, goal.path);
		const actual = await readFile(absolute, "utf8");
		return actual === goal.expected;
	} catch {
		return false;
	}
}
