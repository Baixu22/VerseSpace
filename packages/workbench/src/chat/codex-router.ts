import { resolve } from "node:path";
import type { ParsedStreamFootprint } from "../blackboard/footprint";
import { hashPathClaim } from "../blackboard/footprint";
import { captureReturnedInput } from "../blackboard/footprint-sample";
import type { InputCoverageTracker } from "../blackboard/input-coverage";
import { writerSpoolDir } from "../blackboard/sessions";
import { codexReturnedInput, extractCodexFootprint } from "./codex-footprint";
import {
	type CodexRenderState,
	reduceCodexRenderEvent,
} from "./codex-render-state";
import { observeCodexCandidates } from "./input-coverage-events";
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
	inputCoverage?: InputCoverageTracker;
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
	if (turn.inputCoverage) observeCodexCandidates(turn.inputCoverage, event);
	const result = reduceCodexRenderEvent(turn.render, event);
	if (result.decision === "undecided") {
		turn.undecidedEventTypes.add(result.decisionKey);
	}
	for (const emitted of result.events) turn.emit(emitted);

	// Keep path claims pending until a successful result supplies the receipt.
	for (const { item } of result.newToolItems) {
		recordCommandFootprint(id, turn, item);
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
	id: string,
	turn: CodexTurnState,
	item: Record<string, unknown>,
): void {
	const footprint = extractCodexFootprint(item, id);
	if (!footprint) return;
	turn.pendingFootprints.set(footprint.activity, footprint);
}

function settleCommandFootprint(
	context: ThreadContext,
	id: string,
	turn: CodexTurnState,
	itemId: string,
	item: Record<string, unknown>,
): void {
	const footprint = turn.pendingFootprints.get(itemId);
	if (turn.inputCoverage && !turn.inputCoverage.acceptResult(itemId)) return;
	if (!footprint) {
		turn.inputCoverage?.settle(
			itemId,
			item.status === "failed" ||
				(typeof item.exitCode === "number" && item.exitCode !== 0)
				? null
				: [],
		);
		return;
	}
	turn.pendingFootprints.delete(itemId);
	const failed =
		(item.type === "fileChange" && item.status !== "completed") ||
		item.status === "failed" ||
		(typeof item.exitCode === "number" && item.exitCode !== 0);
	if (failed) {
		turn.inputCoverage?.settle(itemId, null);
		return;
	}
	const returned = codexReturnedInput(context.bb.projectRoot, footprint, item);
	const cwd =
		typeof item.cwd === "string" && item.cwd
			? item.cwd
			: context.bb.projectRoot;
	turn.fpQueue = turn.fpQueue.then(async () => {
		for (const used of footprint.used) {
			Object.assign(
				used,
				await captureReturnedInput(
					context.bb.projectRoot,
					resolve(cwd, used.path),
					returned,
					writerSpoolDir(context.bb.paths, id),
					used.span,
				),
			);
		}
		for (const generated of footprint.generated) {
			Object.assign(
				generated,
				await hashPathClaim(context.bb.projectRoot, generated.path),
			);
		}
		await context.bb.sessions.recordActivity(id, footprint);
		turn.inputCoverage?.settle(itemId, footprint.used);
	});
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
