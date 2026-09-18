import {
	createClaudeRenderState,
	finalClaudeParts,
	foldedClaudeParts,
	reduceClaudeRenderEvent,
} from "./claude-render-state";
import type {
	RunEvent,
	StoredMessage,
	StoredPart,
	TurnRunEvent,
} from "./thread-types";

const MESSAGE_ID = "00000000-0000-4000-8000-000000000002";
const AT = "2026-09-18T00:00:00.000Z";
const encode = (event: RunEvent): string => `${JSON.stringify(event)}\n`;
const bytes = (line: string): number =>
	new TextEncoder().encode(line).byteLength;
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
	return {
		type: "collapsed-group",
		id: part.id,
		category: part.category,
		tools: part.tools.length,
		active: part.active,
		summary: part.summary,
	};
}

export function ipcTotals(baselineBytes: number, optimizedBytes: number) {
	return {
		baselineBytes,
		optimizedBytes,
		savedBytes: baselineBytes - optimizedBytes,
		reductionPercent:
			baselineBytes === 0
				? 0
				: Math.round(
						((baselineBytes - optimizedBytes) / baselineBytes) * 10_000,
					) / 100,
	};
}

/** Test-side wire projection, using serialized envelopes rather than mutable parts. */
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
 * Same stream on both sides: replace only emitted text deltas with complete
 * folded-parts snapshots. Finalized parts, control frames and done are identical.
 * Controls use a fixed ordinary prompt/id/time because SDK fixtures omit input.
 */
export function replayClaudeFixture(
	name: string,
	lines: Record<string, unknown>[],
) {
	const state = createClaudeRenderState();
	const controls: RunEvent[] = [
		{
			type: "user",
			message: {
				id: "00000000-0000-4000-8000-000000000001",
				role: "user",
				text: "Replay the fixture task.",
				at: AT,
			},
		},
		{ type: "turn_started", messageId: MESSAGE_ID },
	];
	const baseline = controls.map(encode);
	const optimized = controls.map(encode);
	let controlBytes = baseline.reduce((sum, line) => sum + bytes(line), 0);
	let doneBytes = 0;
	let finalizedPartsBytes = 0;
	let deltaCount = 0;
	const counts = { finalized: 0, "streaming-delta": 0, noop: 0, undecided: 0 };
	const paths = new Map<string, { decision: string; count: number }>();
	const undecided = new Set<string>();
	const checkpoints: Array<Record<string, unknown>> = [];
	for (const [index, event] of lines.entries()) {
		const result = reduceClaudeRenderEvent(state, event);
		counts[result.decision]++;
		const entry = paths.get(result.decisionKey) ?? {
			decision: result.decision,
			count: 0,
		};
		entry.count++;
		paths.set(result.decisionKey, entry);
		if (result.decision === "undecided") undecided.add(result.decisionKey);
		const emitted = [...result.events];
		// The router, not the render reducer, owns terminal error lifecycle.
		if (
			event.type === "result" &&
			(event.is_error === true || String(event.subtype).startsWith("error"))
		) {
			emitted.push({
				type: "error",
				message:
					typeof event.result === "string" && event.result
						? event.result
						: "agent 回合执行失败",
			});
		}
		for (const output of emitted) {
			const actual = encode(envelope(output));
			const comparison =
				output.type === "delta"
					? encode(
							envelope({
								type: "parts",
								parts: foldedClaudeParts(state, true),
							}),
						)
					: actual;
			optimized.push(actual);
			baseline.push(comparison);
			if (output.type === "delta") deltaCount++;
			if (output.type === "parts") finalizedPartsBytes += bytes(actual);
			if (output.type === "error" || output.type === "notice_delivered")
				controlBytes += bytes(actual);
			checkpoints.push({
				line: index + 1,
				decision: result.decision,
				path: result.decisionKey,
				emission: output.type,
				bytes: bytes(actual),
				baselineBytes: bytes(comparison),
			});
		}
	}
	const finalParts = finalClaudeParts(state);
	const message: StoredMessage = {
		id: MESSAGE_ID,
		role: "assistant",
		text: textOf(finalParts),
		at: AT,
		parts: finalParts,
	};
	const beforeDone = {
		baseline: project(baseline),
		optimized: project(optimized),
	};
	if (
		message.text ||
		state.messageParts.some((part) => part.type === "tool-call")
	) {
		const done = encode(envelope({ type: "done", message }));
		doneBytes = bytes(done);
		baseline.push(done);
		optimized.push(done);
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
			emissionCheckpoints: checkpoints,
			finalMessage: {
				textChars: message.text.length,
				partTypes: finalParts.map((part) => part.type),
				parts: finalParts.map(partShape),
			},
			undecidedKeys: [...undecided].sort(),
			ipc: {
				...ipcTotals(
					baseline.reduce((sum, line) => sum + bytes(line), 0),
					optimized.reduce((sum, line) => sum + bytes(line), 0),
				),
				controlBytes,
				finalizedPartsBytes,
				doneBytes,
				baselineEvents: baseline.length,
				optimizedEvents: optimized.length,
			},
		},
		baseline,
		optimized,
		beforeDone,
		projected: { baseline: project(baseline), optimized: project(optimized) },
		message,
	};
}
