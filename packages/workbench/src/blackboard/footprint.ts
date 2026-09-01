import {
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { hashFile, hashText } from "../hash";
import { tierOf } from "../runtime/durability";
import type { FootprintUsed, ReadSpan } from "./sessions";

/** Files above this size are recorded by size, not hashed. */
const HASH_CAP_BYTES = 2_000_000;
/** Reads at or below this size spool their content — the diff side of an
 * R2 invalidation notice. The spool keeps the newest N files per session. */
const SPOOL_CAP_BYTES = 64_000;
const SPOOL_KEEP = 20;

/**
 * Version a file claim: content hash for files within the cap, plain size
 * above it (the hash budget keeps footprint lines small and capture cheap).
 * Paths are normalized to forward slashes so agent claims (backslash paths
 * from the CLI) and watcher captures (forward slashes) match for attribution.
 * Every claim is tagged with its durability tier (R2 layer 1, O(1)).
 */
export async function hashPathClaim(
	projectRoot: string,
	path: string,
	spoolDir?: string,
	span?: ReadSpan,
): Promise<FootprintUsed> {
	const normalized = path.replace(/\\/g, "/");
	const durability = tierOf(normalized);
	try {
		const abs = isAbsolute(normalized)
			? normalized
			: join(projectRoot, normalized);
		const st = await stat(abs);
		if (st.size > HASH_CAP_BYTES) {
			return { path: normalized, version: null, size: st.size, durability };
		}
		const claim: FootprintUsed = {
			path: normalized,
			version: await hashFile(abs),
			durability,
		};
		if (span) {
			claim.span = {
				start: span.start,
				end: span.end,
				hash: await hashLines(abs, span.start, span.end),
			};
		}
		if (spoolDir && durability === "volatile" && st.size <= SPOOL_CAP_BYTES) {
			claim.spool = await spoolRead(spoolDir, abs, normalized);
		}
		return claim;
	} catch {
		return { path: normalized, version: null, durability }; // missing at capture time
	}
}

/**
 * Hash of an inclusive 1-based line range. Out-of-range reads yield null —
 * the caller treats that as "cannot prove it held", which errs toward
 * notifying, never toward silence.
 */
export async function hashLines(
	absPath: string,
	start: number,
	end: number,
): Promise<string | null> {
	try {
		const text = await readFile(absPath, "utf8");
		const lines = text.split("\n");
		const slice = lines.slice(Math.max(0, start - 1), end);
		if (slice.length === 0) {
			return null;
		}
		return hashText(slice.join("\n"));
	} catch {
		return null;
	}
}

async function spoolRead(
	spoolDir: string,
	absPath: string,
	normalizedPath: string,
): Promise<string> {
	const content = await readFile(absPath, "utf8");
	await mkdir(spoolDir, { recursive: true });
	const safeName = normalizedPath.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80);
	const name = `${Date.now().toString(36)}-${safeName}`;
	await writeFile(join(spoolDir, name), content, "utf8");
	// keep only the newest SPOOL_KEEP spool files
	const names = (await readdir(spoolDir)).sort();
	for (const old of names.slice(0, Math.max(0, names.length - SPOOL_KEEP))) {
		await rm(join(spoolDir, old), { force: true }).catch(() => {});
	}
	return name;
}

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
