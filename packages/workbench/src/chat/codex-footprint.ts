import type { ParsedStreamFootprint } from "../blackboard/footprint";
import type { FootprintUsed } from "../blackboard/session-types";
import { asRecord, stringField } from "./codex-render-blocks";

/**
 * Codex footprint extraction (TF-0249).
 *
 * Claude's footprints come from structured `Read`/`Edit`/`Bash` tool blocks
 * (see `blackboard/footprint.ts`). Codex has no such tools — it runs shell
 * commands and reports them as `commandExecution` items:
 *
 *   { type: "commandExecution", id, command: "/bin/zsh -lc 'cat package.json'",
 *     commandActions: [{ type: "read", path: "$REPO/package.json" }],
 *     aggregatedOutput, exitCode, status }
 *
 * The `commandActions[].path` array is a STRUCTURED file claim the CLI already
 * computed — more reliable than re-parsing the shell string. We prefer it, and
 * fall back to `catPaths`-style parsing of the raw command only when codex
 * reported no structured action (mirrors `footprint.ts`'s Bash branch).
 *
 * `$VAR`-prefixed placeholder paths (from fixture sanitization) and paths that
 * are not clearly file references are dropped — a footprint claim must be a
 * path the ledger can hash, not a token.
 */

/** codex commandAction kinds that put a file INTO context (a read). */
const READ_ACTIONS = new Set(["read", "listFiles"]);
/** codex commandAction kinds that MODIFY a file (a write). */
const WRITE_ACTIONS = new Set(["edit", "write", "applyPatch", "createFile"]);

/** The tool-call shape a codex command becomes for rendering + classification. */
export function codexCommandTool(item: Record<string, unknown>): {
	toolName: string;
	args: { command: string };
} {
	if (stringField(item, "type") === "collabAgentToolCall") {
		// spawnAgent / wait / etc. — a non-file tool; carries no command args.
		return {
			toolName: stringField(item, "tool") || "collab",
			args: { command: "" },
		};
	}
	// Name it so `classifyToolWithArgs` treats it exactly like a Bash call:
	// a readonly command collapses under "shell", anything else stays a plain row.
	return { toolName: "Bash", args: { command: stringField(item, "command") } };
}

/** Cheap `cat <path>` extraction — the same shape as footprint.ts's catPaths. */
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
 * A structured `commandActions[].path` is a claim codex itself computed, so we
 * trust it verbatim — in a real run it is a concrete path; in a sanitized
 * fixture it is a `$DUMMY_REPO/...` placeholder. The ledger's `hashPathClaim`
 * normalizes and (if absent) records version:null, so a placeholder simply
 * hashes to "missing" rather than corrupting the claim.
 */
function structuredClaim(path: unknown): FootprintUsed | null {
	if (typeof path !== "string" || !path.trim()) return null;
	return { path, version: null };
}

/**
 * A path parsed out of the raw shell string (fallback only). Here a leading
 * `$VAR` IS an unexpanded shell token, not a claim — drop it.
 */
function parsedClaim(path: string): FootprintUsed | null {
	if (!path.trim() || path.startsWith("$")) return null;
	return { path, version: null };
}

/**
 * Extract the footprint of ONE codex command item. Returns null for items that
 * carry no file claim (a bare `echo`, a collab tool call, a command whose
 * actions and text yield no path). File versions are attached by the caller,
 * exactly as `extractFootprint` leaves them null for the router to hash.
 */
export function extractCodexFootprint(
	item: Record<string, unknown>,
	agent: string,
): ParsedStreamFootprint | null {
	if (stringField(item, "type") !== "commandExecution") return null;
	const command = stringField(item, "command");
	const activity = stringField(item, "id") || "act-unknown";
	const used: FootprintUsed[] = [];
	const generated: FootprintUsed[] = [];
	const facets: Record<string, unknown> = {
		tool: "command",
		command: command.slice(0, 500),
	};

	const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
	let sawStructuredPath = false;
	for (const raw of actions) {
		const action = asRecord(raw);
		if (!action) continue;
		const kind = stringField(action, "type");
		const claim = structuredClaim(action.path);
		if (!claim) continue;
		if (READ_ACTIONS.has(kind)) {
			used.push(claim);
			sawStructuredPath = true;
		} else if (WRITE_ACTIONS.has(kind)) {
			generated.push(claim);
			sawStructuredPath = true;
		}
	}

	// Fall back to parsing the command only when codex gave no structured path.
	if (!sawStructuredPath) {
		for (const path of catPaths(command)) {
			const claim = parsedClaim(path);
			if (claim) used.push(claim);
		}
	}

	if (used.length === 0 && generated.length === 0) return null;
	return { activity, agent, used, generated, facets };
}
