import { codexCommandTool } from "./codex-footprint";
import {
	appendItemDelta,
	type CodexRenderState,
	finalizeAgentMessage,
	itemOf,
	patchCommandResult,
	stringField,
	upsertCommandTool,
} from "./codex-render-blocks";
import {
	type CodexRenderDecision,
	describeCodexEvent,
	resolveCodexRenderDecision,
} from "./codex-render-decision";
import type { MessagePart, StoredPart, TurnRunEvent } from "./thread-types";
import { collapseParts } from "./tool-collapse";

export {
	type CodexRenderState,
	createCodexRenderState,
} from "./codex-render-blocks";

export interface CodexRenderResult {
	decision: CodexRenderDecision | "undecided";
	decisionKey: string;
	events: TurnRunEvent[];
	/** Newly inserted command/collab tool blocks; the router owns their footprints. */
	newToolItems: Array<{ itemId: string; item: Record<string, unknown> }>;
	/** Completed command items whose result attaches to a pending footprint. */
	toolResultItems: Array<{ itemId: string; item: Record<string, unknown> }>;
}

/** Coalesce adjacent text parts, then apply the shared collapse rules. */
export function foldedCodexParts(
	state: CodexRenderState,
	streaming: boolean,
): StoredPart[] {
	const parts: MessagePart[] = [];
	for (const part of state.messageParts) {
		if (part.type !== "text") {
			parts.push(part);
			continue;
		}
		if (!part.text) continue;
		const last = parts.at(-1);
		if (last?.type === "text") last.text += part.text;
		else parts.push({ ...part });
	}
	return collapseParts(parts, { streaming });
}

const COMMAND_ITEM_TYPES = new Set(["commandExecution", "collabAgentToolCall"]);

/**
 * Pure rendering boundary for one codex line: mutates only its supplied state,
 * no I/O or lifecycle effects. Fixture replay and the live router use this
 * exact reducer — the same guarantee `reduceClaudeRenderEvent` gives.
 */
export function reduceCodexRenderEvent(
	state: CodexRenderState,
	event: Record<string, unknown>,
): CodexRenderResult {
	const verdict = resolveCodexRenderDecision(event);
	const result: CodexRenderResult = {
		decision: verdict?.decision ?? "undecided",
		decisionKey: verdict?.key ?? describeCodexEvent(event),
		events: [],
		newToolItems: [],
		toolResultItems: [],
	};
	if (!verdict) return result;

	if (verdict.decision === "streaming-delta") {
		const itemId = stringField(event, "itemId");
		const delta = stringField(event, "delta");
		const text = appendItemDelta(state, itemId, delta);
		if (text) result.events.push({ type: "delta", text });
		return result;
	}

	if (verdict.decision === "noop" || verdict.decision === "error") {
		return result;
	}

	// finalized: an item/started or item/completed for a rendered item type.
	const type = stringField(event, "type");
	const item = itemOf(event);
	if (!item) return result;
	const itemType = stringField(item, "type");
	const itemId = stringField(item, "id");
	const before = JSON.stringify(foldedCodexParts(state, true));

	if (itemType === "agentMessage" && type === "item/completed") {
		finalizeAgentMessage(state, itemId, stringField(item, "text"));
	} else if (COMMAND_ITEM_TYPES.has(itemType)) {
		const tool = codexCommandTool(item);
		const existed = state.toolByItem.has(itemId);
		upsertCommandTool(state, itemId, tool.toolName, tool.args);
		if (!existed && type === "item/started") {
			result.newToolItems.push({ itemId, item });
		} else if (!existed) {
			// A completed item we never saw start (reconnect): still a new block.
			result.newToolItems.push({ itemId, item });
		}
		if (type === "item/completed") {
			const isError =
				stringField(item, "status") === "failed" ||
				(typeof item.exitCode === "number" && item.exitCode !== 0);
			patchCommandResult(state, itemId, item.aggregatedOutput ?? null, isError);
			result.toolResultItems.push({ itemId, item });
		}
	}

	const parts = foldedCodexParts(state, true);
	if (before !== JSON.stringify(parts)) {
		result.events.push({ type: "parts", parts });
	}
	return result;
}

export function finalCodexParts(state: CodexRenderState): StoredPart[] {
	return foldedCodexParts(state, false);
}
