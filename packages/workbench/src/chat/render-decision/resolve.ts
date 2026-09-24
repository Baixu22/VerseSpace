import { asRecord, contentBlocks } from "../claude-render-blocks";
import {
	ASSISTANT_BLOCK_RENDER_DECISIONS,
	EVENT_RENDER_DECISIONS,
	STREAM_DELTA_RENDER_DECISIONS,
	STREAM_RENDER_DECISIONS,
	SYSTEM_RENDER_DECISIONS,
	USER_BLOCK_RENDER_DECISIONS,
} from "./tables";
import { type RenderVerdict, verdict } from "./types";

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
