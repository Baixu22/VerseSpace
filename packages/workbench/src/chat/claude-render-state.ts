import {
	appendDelta,
	applyAssistant,
	asRecord,
	type ClaudeRenderState,
	contentBlocks,
	observeStream,
	patchToolResult,
} from "./claude-render-blocks";
import { describeRenderEvent, resolveRenderDecision } from "./render-decision";
import { noticeFromSystemEvent } from "./system-notice";
import type { MessagePart, StoredPart, TurnRunEvent } from "./thread-types";
import { collapseParts } from "./tool-collapse";

export {
	type ClaudeRenderState,
	createClaudeRenderState,
} from "./claude-render-blocks";

export interface ClaudeRenderResult {
	decision: "finalized" | "streaming-delta" | "noop" | "notice" | "undecided";
	decisionKey: string;
	events: TurnRunEvent[];
	/** Newly inserted calls only; router owns their side effects. */
	newToolBlocks: Record<string, unknown>[];
	/** Every result is offered to the router's pending-footprint owner. */
	toolResultBlocks: Record<string, unknown>[];
}

/** Coalesce text only at the boundary; block provenance references raw parts. */
export function foldedClaudeParts(
	state: ClaudeRenderState,
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

/**
 * Pure rendering boundary: mutates only its supplied state, with no I/O or
 * lifecycle effects. Fixture replay and the live router use this exact reducer.
 */
export function reduceClaudeRenderEvent(
	state: ClaudeRenderState,
	event: Record<string, unknown>,
): ClaudeRenderResult {
	const verdict = resolveRenderDecision(event);
	const result: ClaudeRenderResult = {
		decision: verdict?.decision ?? "undecided",
		decisionKey: verdict?.key ?? describeRenderEvent(event),
		events: [],
		newToolBlocks: [],
		toolResultBlocks: [],
	};
	if (!verdict) return result;
	if (event.type === "stream_event") observeStream(state, event);
	if (verdict.decision === "streaming-delta") {
		const text = appendDelta(state, event);
		if (text) result.events.push({ type: "delta", text });
		return result;
	}
	if (verdict.decision === "notice") {
		const notice = noticeFromSystemEvent(event);
		// A decided notice with no fields is still *decided*: the shape is
		// known, so it must never be re-reported as protocol drift.
		if (notice) {
			state.messageParts.push({ type: "notice", ...notice });
			result.events.push({
				type: "parts",
				parts: foldedClaudeParts(state, true),
			});
		}
		return result;
	}
	if (event.type === "result") {
		if (
			event.subtype === "success" &&
			event.is_error !== true &&
			typeof event.result === "string" &&
			event.result &&
			!state.messageParts.some((part) => part.type === "text" && part.text)
		) {
			// The fallback text is only a real answer when the turn produced
			// model work (a tool call — the no-text case is checked above). A
			// turn with neither is the poisoned-resume shape observed three
			// times on 2026-09-19: the CLI answers with a receipt line such as
			// "No response requested." and nothing else. Keep the provider's
			// own words on disk — never rewrite them — but say out loud that
			// this is a receipt, not an answer, so it stops reading like one.
			const hasModelWork = state.messageParts.some(
				(part) => part.type === "tool-call",
			);
			if (!hasModelWork) {
				state.messageParts.push({
					type: "notice",
					severity: "warning",
					label: "本轮没有模型输出",
					body: 'result 里只有回执文本（常见为 "No response requested."），没有正文也没有工具调用——多见于被杀回合之后 resume 的会话。别把这条当回答：换一条线程或重发。',
				});
			}
			state.messageParts.push({ type: "text", text: event.result });
			result.events.push({ type: "delta", text: event.result });
			if (!hasModelWork) {
				result.events.push({
					type: "parts",
					parts: foldedClaudeParts(state, true),
				});
			}
		}
		return result;
	}
	if (event.type !== "assistant" && verdict.decision === "noop") return result;
	const before = JSON.stringify(foldedClaudeParts(state, true));
	if (event.type === "assistant") {
		Object.assign(result, applyAssistant(state, event));
	} else if (event.type === "user") {
		for (const value of contentBlocks(event)) {
			const block = asRecord(value)!;
			if (block.type !== "tool_result" && block.type !== "mcp_tool_result")
				continue;
			patchToolResult(state, block);
			result.toolResultBlocks.push(block);
		}
	}
	const parts = foldedClaudeParts(state, true);
	if (before !== JSON.stringify(parts))
		result.events.push({ type: "parts", parts });
	return result;
}

export function finalClaudeParts(state: ClaudeRenderState): StoredPart[] {
	return foldedClaudeParts(state, false);
}
