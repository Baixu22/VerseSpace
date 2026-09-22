import type { MessagePart, ToolCallPart } from "./thread-types";

/**
 * Codex render state (TF-0249).
 *
 * Codex's `app-server` protocol streams *items* through a lifecycle —
 * `item/started` → `item/agentMessage/delta`* → `item/completed` — rather than
 * Claude's cumulative assistant-message snapshots. Each item carries a stable
 * `id`, so the render state keys parts by that id: a delta finds its part by
 * `itemId`, a `commandExecution` upserts a tool-call by its `id`, and the
 * terminal `item/completed` replaces the streamed text with the authoritative
 * `text` field.
 *
 * This mirrors `claude-render-blocks.ts` in spirit — a pure, side-effect-free
 * state the reducer and fixture replay both drive — but the shapes differ
 * because the wire protocols differ. Nothing here does I/O.
 */

export type TextPart = Extract<MessagePart, { type: "text" }>;

export interface CodexRenderState {
	messageParts: MessagePart[];
	/** itemId → the text part it streams into (agentMessage items). */
	textByItem: Map<string, TextPart>;
	/** itemId → the tool-call part it owns (commandExecution / collabAgentToolCall). */
	toolByItem: Map<string, ToolCallPart>;
}

export function createCodexRenderState(): CodexRenderState {
	return {
		messageParts: [],
		textByItem: new Map(),
		toolByItem: new Map(),
	};
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function stringField(
	record: Record<string, unknown> | undefined,
	key: string,
): string {
	const value = record?.[key];
	return typeof value === "string" ? value : "";
}

/** The `item` payload of an `item/started` | `item/completed` event. */
export function itemOf(
	event: Record<string, unknown>,
): Record<string, unknown> | undefined {
	return asRecord(event.item);
}

/**
 * Append streamed text to the part owned by `itemId`, creating it (and pushing
 * it onto messageParts) on first delta. Returns the appended text, or "" when
 * the delta carried none.
 */
export function appendItemDelta(
	state: CodexRenderState,
	itemId: string,
	delta: string,
): string {
	if (!delta) return "";
	let part = state.textByItem.get(itemId);
	if (!part) {
		part = { type: "text", text: "" };
		state.textByItem.set(itemId, part);
		state.messageParts.push(part);
	}
	part.text += delta;
	return delta;
}

/**
 * Finalize an agentMessage item: the `item/completed` `text` field is
 * authoritative, so it replaces whatever the deltas accumulated (they can lag
 * or be absent — `captured-command.jsonl` streams deltas, `delta-text.jsonl`
 * does too, but a reconnect can deliver only the completed item).
 */
export function finalizeAgentMessage(
	state: CodexRenderState,
	itemId: string,
	text: string,
): void {
	const part = state.textByItem.get(itemId);
	if (part) {
		part.text = text;
		return;
	}
	if (!text) return;
	const created: TextPart = { type: "text", text };
	state.textByItem.set(itemId, created);
	state.messageParts.push(created);
}

/**
 * Upsert the tool-call part for a command / collab item. Codex reports the
 * command on both `item/started` and `item/completed`; the completed frame adds
 * the aggregated output as the result. `toolName`/`args` are shaped so the
 * shared classifier (`classifyToolWithArgs`) and collapse rules treat a codex
 * command exactly like a Claude Bash call.
 */
export function upsertCommandTool(
	state: CodexRenderState,
	itemId: string,
	toolName: string,
	args: unknown,
): ToolCallPart {
	let part = state.toolByItem.get(itemId);
	if (!part) {
		part = { type: "tool-call", toolCallId: itemId, toolName, args };
		state.toolByItem.set(itemId, part);
		state.messageParts.push(part);
		return part;
	}
	part.toolName = toolName;
	part.args = args;
	return part;
}

/** Attach a tool result (aggregated command output) to an existing tool part. */
export function patchCommandResult(
	state: CodexRenderState,
	itemId: string,
	result: unknown,
	isError: boolean,
): void {
	const part = state.toolByItem.get(itemId);
	if (!part) return;
	part.result = result ?? null;
	part.isError = isError;
}
