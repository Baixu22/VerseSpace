import { extractCodexFootprint } from "./codex-footprint";
import { asRecord, itemOf, stringField } from "./codex-render-blocks";
import {
	createCodexRenderState,
	finalCodexParts,
	foldedCodexParts,
	reduceCodexRenderEvent,
} from "./codex-render-state";
import type {
	RunEvent,
	StoredMessage,
	StoredPart,
	TurnRunEvent,
} from "./thread-types";
import { flattenToolParts } from "./tool-collapse";

const MESSAGE_ID = "00000000-0000-4000-8000-000000000002";
const AT = "2026-09-22T00:00:00.000Z";
const encode = (event: RunEvent): string => `${JSON.stringify(event)}\n`;
const envelope = (event: TurnRunEvent): RunEvent => ({
	messageId: MESSAGE_ID,
	...event,
});
const textOf = (parts: StoredPart[]): string =>
	parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

function partShape(part: StoredPart): Record<string, unknown> {
	if (part.type === "text") return { type: "text", chars: part.text.length };
	if (part.type === "tool-call")
		return {
			type: "tool-call",
			id: part.toolCallId,
			name: part.toolName,
			settled: part.result !== undefined,
			isError: part.isError === true,
		};
	if (part.type === "notice")
		return { type: "notice", severity: part.severity, label: part.label };
	return {
		type: "collapsed-group",
		id: part.id,
		category: part.category,
		tools: part.tools.length,
		active: part.active,
		summary: part.summary,
	};
}

/** Test-side wire projection: apply the emitted events like a client would. */
function project(lines: string[]): StoredMessage {
	let message: StoredMessage = {
		id: MESSAGE_ID,
		role: "assistant",
		text: "",
		at: AT,
		parts: [],
	};
	for (const line of lines) {
		const event = JSON.parse(line) as RunEvent;
		if (event.type === "delta") {
			message.parts ??= [];
			const parts = message.parts;
			const last = parts.at(-1);
			if (last?.type === "text") last.text += event.text;
			else parts.push({ type: "text", text: event.text });
			message.text = textOf(parts);
		} else if (event.type === "parts") {
			message.parts = event.parts;
			message.text = textOf(event.parts);
		} else if (event.type === "done") message = event.message;
	}
	return message;
}

/**
 * Replay a codex fixture through the exact reducer the live router uses,
 * projecting the emitted stream back into a message. Same optimized/baseline
 * comparison idea as `replayClaudeFixture`: text deltas are the only place the
 * optimized stream differs from a full-parts snapshot, so re-projecting both
 * must land on the identical final message.
 */
export function replayCodexFixture(
	name: string,
	lines: Record<string, unknown>[],
) {
	const state = createCodexRenderState();
	const optimized: string[] = [];
	const baseline: string[] = [];
	const counts = {
		finalized: 0,
		"streaming-delta": 0,
		noop: 0,
		error: 0,
		undecided: 0,
	};
	const paths = new Map<string, { decision: string; count: number }>();
	const undecided = new Set<string>();
	const footprints: Array<{
		activity: string;
		used: string[];
		generated: string[];
	}> = [];
	let deltaCount = 0;

	for (const event of lines) {
		const result = reduceCodexRenderEvent(state, event);
		counts[result.decision]++;
		const entry = paths.get(result.decisionKey) ?? {
			decision: result.decision,
			count: 0,
		};
		entry.count++;
		paths.set(result.decisionKey, entry);
		if (result.decision === "undecided") undecided.add(result.decisionKey);

		// The router records a footprint for every new command item; capture the
		// same claims here so the gate test asserts the footprint channel.
		for (const { item } of result.newToolItems) {
			const fp = extractCodexFootprint(item, name);
			if (fp)
				footprints.push({
					activity: fp.activity,
					used: fp.used.map((u) => u.path),
					generated: fp.generated.map((g) => g.path),
				});
		}

		const emitted = [...result.events];
		if (result.decision === "error") {
			const message =
				stringField(asRecord(event.error), "message") ||
				stringField(asRecord(itemOf(event)), "message") ||
				"codex 回合执行失败";
			emitted.push({ type: "error", message });
		}
		for (const output of emitted) {
			const actual = encode(envelope(output));
			const comparison =
				output.type === "delta"
					? encode(
							envelope({ type: "parts", parts: foldedCodexParts(state, true) }),
						)
					: actual;
			optimized.push(actual);
			baseline.push(comparison);
			if (output.type === "delta") deltaCount++;
		}
	}

	const finalParts = finalCodexParts(state);
	const message: StoredMessage = {
		id: MESSAGE_ID,
		role: "assistant",
		text: textOf(finalParts),
		at: AT,
		parts: finalParts,
	};
	if (message.text || finalParts.some((part) => part.type !== "text")) {
		const done = encode(envelope({ type: "done", message }));
		optimized.push(done);
		baseline.push(done);
	}

	return {
		snapshot: {
			name,
			eventCount: lines.length,
			deltaCount,
			decisionDistribution: counts,
			decisionPaths: Object.fromEntries(
				[...paths].sort(([a], [b]) => a.localeCompare(b)),
			),
			finalMessage: {
				textChars: message.text.length,
				partTypes: finalParts.map((part) => part.type),
				parts: finalParts.map(partShape),
			},
			footprints,
			undecidedKeys: [...undecided].sort(),
		},
		optimized,
		baseline,
		projected: { baseline: project(baseline), optimized: project(optimized) },
		message,
		toolCallIds: flattenToolParts(finalParts).map((tool) => tool.toolCallId),
	};
}
