import type { MessagePart, ToolCallPart } from "./thread-types";

export type TextPart = Extract<MessagePart, { type: "text" }>;

/** Provenance points into raw parts; it never duplicates text, args, or results. */
export interface RenderBlock {
	type: string;
	part?: MessagePart;
}

export interface ClaudeRenderState {
	messageParts: MessagePart[];
	assistantFrames: Map<string, RenderBlock[]>;
	streamMessageId?: string;
	streamBlockIndex?: number;
	pendingText?: TextPart;
}

export function createClaudeRenderState(): ClaudeRenderState {
	return { messageParts: [], assistantFrames: new Map() };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function contentBlocks(event: Record<string, unknown>): unknown[] {
	const content = asRecord(event.message)?.content;
	return Array.isArray(content) ? content : [];
}

function frame(state: ClaudeRenderState, id: string): RenderBlock[] {
	let blocks = state.assistantFrames.get(id);
	if (!blocks) {
		blocks = [];
		state.assistantFrames.set(id, blocks);
	}
	return blocks;
}

/** Lifecycle is a visible noop, but provides unambiguous block identities. */
export function observeStream(
	state: ClaudeRenderState,
	event: Record<string, unknown>,
): void {
	const inner = asRecord(event.event);
	if (inner?.type === "message_start") {
		const id = asRecord(inner.message)?.id;
		state.streamMessageId = typeof id === "string" ? id : undefined;
		state.streamBlockIndex = undefined;
	} else if (
		inner?.type === "content_block_stop" ||
		inner?.type === "message_stop"
	) {
		state.streamBlockIndex = undefined;
	} else if (inner?.type === "content_block_start") {
		state.streamBlockIndex =
			typeof inner.index === "number" ? inner.index : undefined;
		if (state.streamMessageId && state.streamBlockIndex !== undefined) {
			const blocks = frame(state, state.streamMessageId);
			blocks[state.streamBlockIndex] ??= {
				type: String(asRecord(inner.content_block)?.type),
			};
		}
	}
}

export function appendDelta(
	state: ClaudeRenderState,
	event: Record<string, unknown>,
): string {
	const inner = asRecord(event.event);
	const delta = asRecord(inner?.delta);
	const text = typeof delta?.text === "string" ? delta.text : "";
	if (!text) return "";
	const index =
		typeof inner?.index === "number" ? inner.index : state.streamBlockIndex;
	let block: RenderBlock | undefined;
	if (state.streamMessageId && index !== undefined) {
		const blocks = frame(state, state.streamMessageId);
		block = blocks[index] ??= { type: "text" };
	}
	let part = block?.part?.type === "text" ? block.part : state.pendingText;
	if (
		!part ||
		part !== state.messageParts.at(-1) ||
		(block && block.part !== part)
	) {
		part = { type: "text", text: "" };
		state.messageParts.push(part);
	}
	part.text += text;
	if (block) block.part = part;
	state.pendingText = part;
	return text;
}

function matches(
	block: RenderBlock,
	incoming: Record<string, unknown>,
): boolean {
	if (block.type !== incoming.type) return false;
	if (block.part?.type === "tool-call")
		return block.part.toolCallId === incoming.id;
	if (block.part?.type === "text") return block.part.text === incoming.text;
	return !block.part;
}

function blockIndex(
	state: ClaudeRenderState,
	id: string,
	blocks: RenderBlock[],
	incoming: Record<string, unknown>,
	index: number,
	count: number,
): number {
	// Multi-block assistant envelopes are cumulative snapshots in provider order.
	if (count > 1) return index;
	const exact = blocks.findIndex((block) => block && matches(block, incoming));
	if (id === state.streamMessageId && state.streamBlockIndex !== undefined) {
		const streamed = blocks[state.streamBlockIndex];
		if (
			streamed &&
			streamed.type === incoming.type &&
			(exact < 0 || streamed.part === state.pendingText)
		) {
			return state.streamBlockIndex;
		}
	}
	if (exact >= 0) return exact;
	// A growing singleton text snapshot replaces its prior prefix, not appends it.
	const last = blocks.at(-1);
	if (
		incoming.type === "text" &&
		last?.part?.type === "text" &&
		!state.pendingText
	) {
		const text = String(incoming.text ?? "");
		// Claude can replay an older cumulative snapshot after a newer one.
		// Keep the longer terminal text instead of regressing to the old prefix.
		if (last.part.text.startsWith(text)) return blocks.length - 1;
		if (text.startsWith(last.part.text)) {
			return blocks.length - 1;
		}
	}
	return blocks.length;
}

function upsertTool(
	state: ClaudeRenderState,
	block: Record<string, unknown>,
): ToolCallPart {
	const toolCallId = String(block.id ?? "");
	let part = state.messageParts.find(
		(candidate): candidate is ToolCallPart =>
			candidate.type === "tool-call" && candidate.toolCallId === toolCallId,
	);
	if (!part) {
		part = { type: "tool-call", toolCallId, toolName: "tool", args: {} };
		state.messageParts.push(part);
	}
	part.toolName = String(block.name ?? "tool");
	part.args = block.input ?? {};
	return part;
}

export function patchToolResult(
	state: ClaudeRenderState,
	block: Record<string, unknown>,
): void {
	const part = state.messageParts.find(
		(candidate): candidate is ToolCallPart =>
			candidate.type === "tool-call" &&
			candidate.toolCallId === block.tool_use_id,
	);
	if (!part) return;
	part.result = block.content ?? null;
	part.isError = block.is_error === true;
}

export function applyAssistant(
	state: ClaudeRenderState,
	event: Record<string, unknown>,
) {
	const message = asRecord(event.message);
	const id = typeof message?.id === "string" ? message.id : "(anonymous)";
	const blocks = frame(state, id);
	const incoming = contentBlocks(event);
	const newToolBlocks: Record<string, unknown>[] = [];
	const toolResultBlocks: Record<string, unknown>[] = [];
	for (const [index, value] of incoming.entries()) {
		const block = asRecord(value)!; // The decision gate validates every block first.
		if (block.type === "tool_result" || block.type === "mcp_tool_result") {
			patchToolResult(state, block);
			toolResultBlocks.push(block);
			continue;
		}
		const slot = blockIndex(state, id, blocks, block, index, incoming.length);
		const previous = blocks[slot];
		const entry: RenderBlock = { type: String(block.type) };
		if (block.type === "text") {
			const pending =
				state.pendingText === state.messageParts.at(-1)
					? state.pendingText
					: undefined;
			const part = previous?.part?.type === "text" ? previous.part : pending;
			entry.part = part ?? { type: "text", text: "" };
			const incomingText = String(block.text ?? "");
			if (!entry.part.text.startsWith(incomingText)) {
				entry.part.text = incomingText;
			}
			if (!part) state.messageParts.push(entry.part);
			if (state.pendingText === part) state.pendingText = undefined;
		} else if (block.type === "tool_use" || block.type === "mcp_tool_use") {
			const exists = state.messageParts.some(
				(part) => part.type === "tool-call" && part.toolCallId === block.id,
			);
			entry.part = upsertTool(state, block);
			if (!exists) newToolBlocks.push(block);
		}
		blocks[slot] = entry;
	}
	return { newToolBlocks, toolResultBlocks };
}
