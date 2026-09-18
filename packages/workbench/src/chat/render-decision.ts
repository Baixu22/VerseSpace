import { asRecord, contentBlocks } from "./claude-render-blocks";

/** Explicit rendering consequence for every Claude stream shape we accept. */
export type RenderDecision = "finalized" | "streaming-delta" | "noop";

export interface RenderVerdict {
	decision: RenderDecision;
	/** Stable, fixture-auditable event path. */
	key: string;
	reason: string;
}

const verdict = (
	key: string,
	decision: RenderDecision,
	reason: string,
): RenderVerdict => ({ key, decision, reason });

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

export const SYSTEM_RENDER_DECISIONS: Record<string, RenderVerdict> =
	Object.fromEntries(
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
	);

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

function stringAt(
	record: Record<string, unknown> | undefined,
	key: string,
): string {
	const value = record?.[key];
	return typeof value === "string" ? value : "(missing)";
}

function recordAt(
	record: Record<string, unknown> | undefined,
	key: string,
): Record<string, unknown> | undefined {
	return asRecord(record?.[key]);
}

function lookup(
	table: Record<string, RenderVerdict>,
	key: string,
): RenderVerdict | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

function resolveBlocks(
	event: Record<string, unknown>,
	table: Record<string, RenderVerdict>,
	prefix: string,
): RenderVerdict | undefined {
	const blocks = contentBlocks(event);
	if (blocks.length === 0) {
		return verdict(prefix, "noop", "empty finalized content envelope");
	}
	let visible = false;
	const paths = new Set<string>();
	for (const block of blocks) {
		const blockType = stringAt(asRecord(block), "type");
		const decision = lookup(table, blockType);
		if (!decision) return undefined;
		paths.add(blockType);
		visible ||= decision.decision !== "noop";
	}
	return verdict(
		`${prefix}.content.${[...paths].sort().join("+")}`,
		visible ? "finalized" : "noop",
		"explicit decisions for every finalized content block",
	);
}

function resolveStreamEvent(
	event: Record<string, unknown>,
): RenderVerdict | undefined {
	const inner = recordAt(event, "event");
	const innerType = stringAt(inner, "type");
	if (innerType === "content_block_delta") {
		const deltaType = stringAt(recordAt(inner, "delta"), "type");
		return lookup(STREAM_DELTA_RENDER_DECISIONS, deltaType);
	}
	if (innerType === "content_block_start") {
		const blockType = stringAt(recordAt(inner, "content_block"), "type");
		if (!lookup(ASSISTANT_BLOCK_RENDER_DECISIONS, blockType)) return undefined;
		return verdict(
			`stream_event.content_block_start.${blockType}`,
			"noop",
			"the finalized assistant frame owns the block",
		);
	}
	return lookup(STREAM_RENDER_DECISIONS, innerType);
}

/** The decision for one raw line, or undefined when any nested shape is new. */
export function resolveRenderDecision(
	event: Record<string, unknown>,
): RenderVerdict | undefined {
	const type = stringAt(event, "type");
	if (type === "stream_event") return resolveStreamEvent(event);
	if (type === "system") {
		return lookup(SYSTEM_RENDER_DECISIONS, stringAt(event, "subtype"));
	}
	if (type === "assistant") {
		return resolveBlocks(event, ASSISTANT_BLOCK_RENDER_DECISIONS, "assistant");
	}
	if (type === "user") {
		return resolveBlocks(event, USER_BLOCK_RENDER_DECISIONS, "user");
	}
	if (type === "result") {
		const subtype = stringAt(event, "subtype");
		if (
			event.is_error !== true &&
			subtype !== "success" &&
			!subtype.startsWith("error")
		) {
			return undefined;
		}
		return verdict(`result.${subtype}`, "finalized", "turn terminal frame");
	}
	return lookup(EVENT_RENDER_DECISIONS, type);
}

/** Most-specific path used when a provider shape has no decision. */
export function describeRenderEvent(event: Record<string, unknown>): string {
	const type = stringAt(event, "type");
	if (type === "stream_event") {
		const inner = recordAt(event, "event");
		const innerType = stringAt(inner, "type");
		if (innerType === "content_block_delta") {
			return `stream_event.content_block_delta.${stringAt(recordAt(inner, "delta"), "type")}`;
		}
		if (innerType === "content_block_start") {
			return `stream_event.content_block_start.${stringAt(recordAt(inner, "content_block"), "type")}`;
		}
		return `stream_event.${innerType}`;
	}
	if (type === "system" || type === "result") {
		return `${type}.${stringAt(event, "subtype")}`;
	}
	if (type === "assistant" || type === "user") {
		const table =
			type === "assistant"
				? ASSISTANT_BLOCK_RENDER_DECISIONS
				: USER_BLOCK_RENDER_DECISIONS;
		const unknown = contentBlocks(event).findIndex(
			(block) => !lookup(table, stringAt(asRecord(block), "type")),
		);
		return unknown >= 0
			? `${type}.content.${stringAt(asRecord(contentBlocks(event)[unknown]), "type")}`
			: type;
	}
	return type;
}
