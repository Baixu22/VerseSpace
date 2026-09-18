/**
 * Collapse consecutive read/search/shell tool calls into one summary row
 * (TF-0206).
 *
 * Rule set is aligned with Claude Code's own TUI (`getSearchReadSummaryText`,
 * mirrored by the Rust `pipeline/collapse.rs` and the legacy frontend): search
 * patterns are de-duplicated and truncated, read files are counted by distinct
 * path, shell commands are counted. Folding is presentation only — the tool
 * calls stay inside the group, so nothing is dropped.
 *
 * Boundaries:
 * - A run of collapsible tool calls accumulates into one group.
 * - Text, reasoning, or a non-collapsible tool call flushes the group. The
 *   group must render BEFORE the part that ended it, otherwise reads appear to
 *   have happened after the text that followed them.
 * - A group of fewer than 2 tools is not folded: one "read" is already one row.
 * - A group is `active` only while the message streams AND its last tool has no
 *   result yet — the spinner stops when the work does.
 */

import type {
	CollapsedGroupPart,
	StoredPart,
	ToolCallPart,
} from "./thread-types";
import { classifyToolWithArgs } from "./tool-classify";

const MAX_PATTERN_CHARS = 40;

export interface CollapseOptions {
	/** The message is still streaming; only then can a group be `active`. */
	streaming: boolean;
}

function truncate(text: string, limit: number): string {
	const characters = Array.from(text);
	if (characters.length <= limit) return text;
	return `${characters.slice(0, limit - 1).join("")}…`;
}

/** Extract a search pattern string from tool args. */
function extractPattern(args: unknown): string | null {
	const record = asRecord(args);
	if (!record) return null;
	for (const key of ["pattern", "query", "search", "regex", "glob"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

/** Extract a file path from tool args. */
function extractFilePath(args: unknown): string | null {
	const record = asRecord(args);
	if (!record) return null;
	for (const key of ["file_path", "path", "file", "url"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function categoryOf(tool: ToolCallPart): "search" | "read" | "shell" {
	const category = classifyToolWithArgs(tool.toolName, tool.args);
	if (category === "search") return "search";
	if (category === "shell") return "shell";
	return "read";
}

/**
 * Build the summary line for a group (Chinese, matching the workbench UI's
 * language; the *rules* — dedup, counts, truncation — are the Claude Code TUI
 * rules, not the wording).
 */
export function buildGroupSummary(
	tools: ToolCallPart[],
	active: boolean,
): string {
	const searchTools: ToolCallPart[] = [];
	const readTools: ToolCallPart[] = [];
	const shellTools: ToolCallPart[] = [];
	for (const tool of tools) {
		const category = categoryOf(tool);
		if (category === "search") searchTools.push(tool);
		else if (category === "shell") shellTools.push(tool);
		else readTools.push(tool);
	}

	const parts: string[] = [];

	if (searchTools.length > 0) {
		const patterns: string[] = [];
		const seen = new Set<string>();
		for (const tool of searchTools) {
			const pattern = extractPattern(tool.args);
			if (!pattern) continue;
			if (seen.has(pattern)) continue;
			seen.add(pattern);
			patterns.push(truncate(pattern, MAX_PATTERN_CHARS));
		}

		if (patterns.length === 1) {
			const verb = active ? "搜索中" : "搜索过";
			const suffix = searchTools.length > 1 ? `（${searchTools.length}×）` : "";
			parts.push(`${verb} '${patterns[0]}'${suffix}`);
		} else if (patterns.length > 1) {
			const suffix =
				searchTools.length > patterns.length
					? `（${searchTools.length}×）`
					: "";
			parts.push(
				`${active ? "搜索中" : "搜索过"} ${patterns.length} 个模式${suffix}`,
			);
		} else {
			parts.push(`${active ? "搜索中" : "搜索过"} ${searchTools.length} 次`);
		}
	}

	if (readTools.length > 0) {
		const paths = new Set<string>();
		for (const tool of readTools) {
			const path = extractFilePath(tool.args);
			if (path) paths.add(path);
		}
		const count = paths.size > 0 ? paths.size : readTools.length;
		parts.push(`${active ? "读取中" : "读取"} ${count} 个文件`);
	}

	if (shellTools.length > 0) {
		parts.push(`${active ? "运行中" : "运行"} ${shellTools.length} 条只读命令`);
	}

	if (parts.length === 0) {
		return active ? "处理中…" : "已完成";
	}
	const joined = parts.join("，");
	return active ? `${joined}…` : joined;
}

function buildGroup(
	tools: ToolCallPart[],
	streaming: boolean,
): CollapsedGroupPart {
	const flags = { search: false, read: false, shell: false };
	for (const tool of tools) {
		flags[categoryOf(tool)] = true;
	}
	const kinds = Number(flags.search) + Number(flags.read) + Number(flags.shell);
	const category: CollapsedGroupPart["category"] =
		kinds > 1
			? "mixed"
			: flags.search
				? "search"
				: flags.shell
					? "shell"
					: "read";

	const lastTool = tools[tools.length - 1];
	const active = streaming && lastTool?.result === undefined;

	const firstId = tools[0]?.toolCallId ?? "empty";
	return {
		type: "collapsed-group",
		id: `group:${firstId}`,
		category,
		tools,
		active,
		summary: buildGroupSummary(tools, active),
	};
}

/**
 * Fold consecutive collapsible tool calls in one assistant message.
 *
 * `CollapsedGroupPart`s already present in `parts` are folded through, not
 * nested: a streaming turn re-renders from the raw parts, and a reload renders
 * from stored parts, so both must produce the same shape.
 */
export function collapseParts(
	parts: StoredPart[],
	options: CollapseOptions,
): StoredPart[] {
	const result: StoredPart[] = [];
	let group: ToolCallPart[] = [];

	const flush = (): void => {
		if (group.length === 0) return;
		if (group.length >= 2) {
			result.push(buildGroup(group, options.streaming));
		} else {
			result.push(group[0]!);
		}
		group = [];
	};

	for (const part of parts.flatMap((part) =>
		part.type === "collapsed-group" ? part.tools : [part],
	)) {
		if (part.type === "tool-call" && isCollapsible(part)) {
			group.push(part);
			continue;
		}
		flush();
		result.push(part);
	}
	flush();

	return structuredClone(result);
}

function isCollapsible(tool: ToolCallPart): boolean {
	const category = classifyToolWithArgs(tool.toolName, tool.args);
	return category === "search" || category === "read" || category === "shell";
}

/**
 * Every tool call reachable in `parts`, including the ones hidden inside folded
 * groups. Read-side consumers (evidence refs, the resume narrative, the
 * "did this turn touch anything" check) must go through this rather than
 * filtering top-level `tool-call` parts, or folding would silently drop facts.
 */
export function flattenToolParts(
	parts: StoredPart[] | undefined,
): ToolCallPart[] {
	const out: ToolCallPart[] = [];
	for (const part of parts ?? []) {
		if (part.type === "collapsed-group") out.push(...part.tools);
		else if (part.type === "tool-call") out.push(part);
	}
	return out;
}
