import type { ParsedStreamFootprint } from "../blackboard/footprint";
import { hashPathClaim } from "../blackboard/footprint";
import { writerSpoolDir } from "../blackboard/sessions";
import { extractCodexFootprint } from "./codex-footprint";
import {
	type CodexRenderState,
	reduceCodexRenderEvent,
} from "./codex-render-state";
import type { ThreadContext } from "./thread-context";
import type { TurnRunEvent } from "./thread-types";

/**
 * Per-turn state the codex router fills, mirroring the claude `ActiveTurn` slice
 * that matters here: the render state, the pending footprints keyed by command
 * id, and the serialized hashing queue.
 */
export interface CodexTurnState {
	render: CodexRenderState;
	pendingFootprints: Map<string, ParsedStreamFootprint>;
	fpQueue: Promise<void>;
	undecidedEventTypes: Set<string>;
	emit: (event: TurnRunEvent) => void;
}

/**
 * Route one normalized codex event through the shared reducer and the footprint
 * side-effect owners. Same division of labour as `claude-router.ts`: the
 * reducer decides rendering, the router performs I/O (footprint hashing, ledger
 * writes) for the tool blocks the reducer surfaced.
 */
export function routeCodexEvent(
	context: ThreadContext,
	id: string,
	turn: CodexTurnState,
	event: Record<string, unknown>,
): void {
	const result = reduceCodexRenderEvent(turn.render, event);
	if (result.decision === "undecided") {
		turn.undecidedEventTypes.add(result.decisionKey);
	}
	for (const emitted of result.events) turn.emit(emitted);

	// A newly-seen command item: capture its footprint claim (file versions are
	// hashed asynchronously, exactly as the claude router does).
	for (const { item } of result.newToolItems) {
		recordCommandFootprint(context, id, turn, item);
	}
	// The completed command item carries success/failure — a failed command is
	// not a proven read/write, so drop its pending footprint.
	for (const { itemId, item } of result.toolResultItems) {
		settleCommandFootprint(context, id, turn, itemId, item);
	}

	if (result.decision === "error") {
		const error = asRecord(event.error);
		const message =
			(typeof error?.message === "string" && error.message) ||
			"codex 回合执行失败";
		turn.emit({ type: "error", message });
	}
}

function recordCommandFootprint(
	context: ThreadContext,
	id: string,
	turn: CodexTurnState,
	item: Record<string, unknown>,
): void {
	const footprint = extractCodexFootprint(item, id);
	if (!footprint) return;
	turn.pendingFootprints.set(footprint.activity, footprint);
	// Hash the read side now (content at observation time), same as the claude
	// path: reads are versioned when seen, writes when the result confirms them.
	turn.fpQueue = turn.fpQueue.then(async () => {
		for (const used of footprint.used) {
			Object.assign(
				used,
				await hashPathClaim(
					context.bb.projectRoot,
					used.path,
					writerSpoolDir(context.bb.paths, id),
					used.span,
				),
			);
		}
	});
}

function settleCommandFootprint(
	context: ThreadContext,
	id: string,
	turn: CodexTurnState,
	itemId: string,
	item: Record<string, unknown>,
): void {
	const footprint = turn.pendingFootprints.get(itemId);
	if (!footprint) return;
	turn.pendingFootprints.delete(itemId);
	const failed =
		item.status === "failed" ||
		(typeof item.exitCode === "number" && item.exitCode !== 0);
	if (failed) return; // a failed command did not prove a read/write
	turn.fpQueue = turn.fpQueue.then(async () => {
		for (const generated of footprint.generated) {
			Object.assign(
				generated,
				await hashPathClaim(context.bb.projectRoot, generated.path),
			);
		}
		await context.bb.sessions.recordActivity(id, footprint);
	});
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
