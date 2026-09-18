import { isReadonlyShell } from "./shell-readonly";

export type ToolCategory = "search" | "read" | "shell" | "other";

/** Convert camelCase / kebab-case tool names to snake_case for stable matching. */
export function normalizeToolName(name: string): string {
	return name
		.replace(/-/g, "_")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase();
}

const SEARCH_TOOLS = new Set([
	// Built-in Claude Code tools
	"grep",
	"glob",
	"web_search",
	"tool_search",
	"search",
	"find_files",
	"search_files",
	"ripgrep",
	// Common MCP search tools
	"slack_search",
	"slack_search_messages",
	"github_search_code",
	"github_search_issues",
	"github_search_repositories",
	"linear_search_issues",
	"jira_search_jira_issues",
	"confluence_search",
	"notion_search",
	"gmail_search_messages",
	"gmail_search",
	"google_drive_search",
	"sentry_search_issues",
	"datadog_search_logs",
	"mongodb_find",
]);

const READ_TOOLS = new Set([
	// Built-in Claude Code tools
	"read",
	"read_file",
	"web_fetch",
	"list_directory",
	"list_dir",
	"ls",
	// Common MCP read tools
	"slack_read_channel",
	"slack_get_message",
	"slack_get_channel_history",
	"github_get_file_contents",
	"github_get_issue",
	"github_get_pull_request",
	"github_list_issues",
	"github_list_pull_requests",
	"github_list_commits",
	"github_get_commit",
	"linear_get_issue",
	"jira_get_jira_issue",
	"confluence_get_page",
	"notion_get_page",
	"notion_fetch_page",
	"gmail_read_message",
	"google_drive_fetch",
	"mongodb_aggregate",
]);

/** Tool names that indicate a bash/shell execution tool. */
const SHELL_TOOL_NAMES = new Set([
	"bash",
	"run",
	"shell",
	"execute",
	"command",
	"exec",
]);

/** Classify a tool by name alone. */
export function classifyTool(rawName: string): ToolCategory {
	const normalized = normalizeToolName(rawName);

	if (SEARCH_TOOLS.has(normalized)) return "search";
	if (READ_TOOLS.has(normalized)) return "read";

	// MCP tool prefix matching: mcp__server__tool_name
	if (normalized.startsWith("mcp__")) {
		const toolPart = normalized.split("__").slice(2).join("__");
		if (SEARCH_TOOLS.has(toolPart) || toolPart.startsWith("search")) {
			return "search";
		}
		if (
			READ_TOOLS.has(toolPart) ||
			toolPart.startsWith("read") ||
			toolPart.startsWith("get_") ||
			toolPart.startsWith("list_") ||
			toolPart.startsWith("fetch")
		) {
			return "read";
		}
	}

	// Heuristic: bare tool names with search/read prefixes
	if (normalized.startsWith("search_") || normalized.endsWith("_search")) {
		return "search";
	}
	if (
		normalized.startsWith("read_") ||
		normalized.startsWith("get_") ||
		normalized.startsWith("list_") ||
		normalized.startsWith("fetch_")
	) {
		return "read";
	}

	return "other";
}

/** Classify a tool, inspecting the command when the tool is a shell executor. */
export function classifyToolWithArgs(
	rawName: string,
	args: unknown,
): ToolCategory {
	const base = classifyTool(rawName);
	if (base !== "other") return base;

	if (!SHELL_TOOL_NAMES.has(normalizeToolName(rawName))) return "other";
	const command = asRecord(args)?.command;
	return typeof command === "string" && isReadonlyShell(command)
		? "shell"
		: "other";
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}
