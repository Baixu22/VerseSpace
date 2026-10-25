import type { FootprintUsed, ReadSpan } from "./sessions";

export { hashLines, hashPathClaim } from "./footprint-sample";

/**
 * stream-json footprint extraction (R1): claude's stream-json output is the
 * documented contract (unlike the transcript file, an internal format that
 * changes with CLI versions), so tool_use / tool_result lines ARE the
 * capture channel. Both agent paths — chat threads and the batch runner —
 * feed their stream lines through this pure extractor.
 *
 * `parent_tool_use_id` attributes subagent activity (forwarded verbatim by
 * the CLI since v2.1.219 at any nesting depth) to the subagent's tool call,
 * so one session can carry many acting agents.
 */

export interface ParsedStreamFootprint {
	activity: string;
	agent: string;
	used: FootprintUsed[];
	generated: FootprintUsed[];
	facets: Record<string, unknown>;
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function pathOfRead(
	tool: string,
	args: Record<string, unknown>,
): string | null {
	if (tool === "Read") {
		return typeof args.file_path === "string" ? args.file_path : null;
	}
	if (tool === "NotebookEdit") {
		return typeof args.notebook_path === "string" ? args.notebook_path : null;
	}
	if (tool === "Grep" || tool === "Glob") {
		return typeof args.path === "string" ? args.path : null;
	}
	if (tool === "LS") {
		return typeof args.path === "string" ? args.path : null;
	}
	return null;
}

/**
 * R2 layer 2: a partial Read (`offset` / `limit`) only puts that line range
 * into context. `limit` without `offset` starts at line 1; `offset` without
 * `limit` runs to EOF. A bare full-file Read yields null and stays at layer 1.
 */
function spanOfRead(args: Record<string, unknown>): ReadSpan | null {
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	if (offset === undefined && limit === undefined) {
		return null;
	}
	const start = Math.max(1, Math.trunc(offset ?? 1));
	const end =
		limit === undefined
			? Number.MAX_SAFE_INTEGER
			: start + Math.trunc(limit) - 1;
	if (end < start) {
		return null;
	}
	return { start, end };
}

function pathOfWrite(args: Record<string, unknown>): string | null {
	if (typeof args.file_path === "string") {
		return args.file_path;
	}
	if (typeof args.notebook_path === "string") {
		return args.notebook_path;
	}
	return null;
}

/** Cheap `cat <path>` extraction: Bash reads are real reads, grade later. */
function catPaths(command: string): string[] {
	const paths: string[] = [];
	for (const match of command.matchAll(
		/cat(?:\s+-[A-Za-z0-9]+)*\s+([^\s|;>&]+)/g,
	)) {
		const candidate = match[1];
		if (
			candidate &&
			!candidate.startsWith("-") &&
			!candidate.startsWith("$") &&
			!candidate.startsWith("`")
		) {
			paths.push(candidate.replace(/^"|"$/g, ""));
		}
	}
	return paths;
}

/**
 * Extract the footprint of ONE tool call from a parsed stream-json event.
 * Returns null for anything that is not a tool call (text deltas, results,
 * system lines…). Call this at the tool_use parse point; file versions are
 * attached by the caller (it can hash content at the right moment).
 */
export function extractFootprint(
	event: Record<string, unknown>,
	defaultAgent: string,
): ParsedStreamFootprint | null {
	if (event.type !== "assistant") {
		return null;
	}
	const message = event.message as
		| { content?: Array<Record<string, unknown>> }
		| undefined;
	for (const block of message?.content ?? []) {
		if (block.type !== "tool_use") {
			continue;
		}
		const toolName = String(block.name ?? "tool");
		const args = (block.input ?? {}) as Record<string, unknown>;
		const used: FootprintUsed[] = [];
		const generated: FootprintUsed[] = [];
		const facets: Record<string, unknown> = { tool: toolName };

		if (READ_TOOLS.has(toolName)) {
			const path = pathOfRead(toolName, args);
			if (path) {
				const span = toolName === "Read" ? spanOfRead(args) : null;
				used.push(
					span ? { path, version: null, span } : { path, version: null },
				);
			}
		} else if (WRITE_TOOLS.has(toolName)) {
			const path = pathOfWrite(args);
			if (path) {
				generated.push({ path, version: null });
			}
		} else if (toolName === "Bash" || toolName === "PowerShell") {
			const command = typeof args.command === "string" ? args.command : "";
			facets.command = command.slice(0, 500);
			for (const path of catPaths(command)) {
				used.push({ path, version: null });
			}
		} else {
			return null; // non-file tools (Task, WebSearch…) carry no file claims
		}

		if (used.length === 0 && generated.length === 0) {
			return null;
		}
		const parent = event.parent_tool_use_id;
		return {
			activity: String(block.id ?? "act-unknown"),
			agent: typeof parent === "string" ? parent : defaultAgent,
			used,
			generated,
			facets,
		};
	}
	return null;
}
