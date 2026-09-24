import { type RenderVerdict, verdict } from "./types";

export const EVENT_RENDER_DECISIONS: Record<string, RenderVerdict> = {
	auth_status: verdict("auth_status", "noop", "credential telemetry"),
	contextUsageUpdated: verdict(
		"contextUsageUpdated",
		"noop",
		"context-usage telemetry",
	),
	rate_limit_event: verdict(
		"rate_limit_event",
		"noop",
		"rate-limit telemetry; the provider result owns the visible outcome",
	),
	tool_use_summary: verdict(
		"tool_use_summary",
		"noop",
		"provider summary would duplicate the Workbench collapse summary",
	),
	end: verdict("end", "noop", "transport sentinel"),
};

export const SYSTEM_RENDER_DECISIONS: Record<string, RenderVerdict> = {
	...Object.fromEntries(
		[
			"init",
			"status",
			"api_retry",
			"compact_boundary",
			"task_notification",
			"task_progress",
			"task_started",
			"task_updated",
			"thinking_tokens",
		].map((subtype) => [
			subtype,
			verdict(`system.${subtype}`, "noop", "session/task bookkeeping"),
		]),
	),
	// Not bookkeeping: the CLI refused an action and the provider told us why.
	// Rendered as a visible notice so a denied write stops reading as an
	// unexplained tool failure (field mapping: system-notice.ts).
	permission_denied: verdict(
		"system.permission_denied",
		"notice",
		"a refused action, with the provider's reason",
	),
};

export const STREAM_RENDER_DECISIONS: Record<string, RenderVerdict> = {
	message_start: verdict(
		"stream_event.message_start",
		"noop",
		"stream block lifecycle",
	),
	message_delta: verdict(
		"stream_event.message_delta",
		"noop",
		"usage/stop metadata",
	),
	message_stop: verdict(
		"stream_event.message_stop",
		"noop",
		"stream block lifecycle",
	),
	content_block_stop: verdict(
		"stream_event.content_block_stop",
		"noop",
		"the finalized assistant frame owns the block",
	),
};

export const STREAM_DELTA_RENDER_DECISIONS: Record<string, RenderVerdict> = {
	text_delta: verdict(
		"stream_event.content_block_delta.text_delta",
		"streaming-delta",
		"append only the new text tail",
	),
	thinking_delta: verdict(
		"stream_event.content_block_delta.thinking_delta",
		"noop",
		"reasoning is outside TF-0206's Workbench thread surface",
	),
	signature_delta: verdict(
		"stream_event.content_block_delta.signature_delta",
		"noop",
		"provider reasoning signature is not rendered",
	),
	input_json_delta: verdict(
		"stream_event.content_block_delta.input_json_delta",
		"noop",
		"the finalized tool_use block owns parsed arguments",
	),
};

export const ASSISTANT_BLOCK_RENDER_DECISIONS: Record<string, RenderVerdict> = {
	text: verdict("assistant.content.text", "finalized", "finalized text block"),
	tool_use: verdict(
		"assistant.content.tool_use",
		"finalized",
		"finalized tool call",
	),
	mcp_tool_use: verdict(
		"assistant.content.mcp_tool_use",
		"finalized",
		"finalized MCP tool call",
	),
	tool_result: verdict(
		"assistant.content.tool_result",
		"finalized",
		"tool result update",
	),
	mcp_tool_result: verdict(
		"assistant.content.mcp_tool_result",
		"finalized",
		"MCP tool result update",
	),
	thinking: verdict(
		"assistant.content.thinking",
		"noop",
		"reasoning is outside TF-0206's Workbench thread surface",
	),
	signature: verdict(
		"assistant.content.signature",
		"noop",
		"provider reasoning signature",
	),
	redacted_thinking: verdict(
		"assistant.content.redacted_thinking",
		"noop",
		"opaque reasoning",
	),
	compaction: verdict(
		"assistant.content.compaction",
		"noop",
		"compaction metadata is not a Workbench chat part",
	),
	container_upload: verdict(
		"assistant.content.container_upload",
		"noop",
		"container upload metadata is not a Workbench chat part",
	),
};

export const USER_BLOCK_RENDER_DECISIONS: Record<string, RenderVerdict> = {
	mcp_tool_result: verdict(
		"user.content.mcp_tool_result",
		"finalized",
		"MCP tool result update",
	),
	tool_result: verdict(
		"user.content.tool_result",
		"finalized",
		"tool result updates the visible tool row",
	),
	text: verdict(
		"user.content.text",
		"noop",
		"provider transcript bookkeeping, not a new local user message",
	),
};
