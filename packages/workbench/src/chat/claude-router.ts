import { extractFootprint, hashPathClaim } from "../blackboard/footprint";
import { captureReturnedInput } from "../blackboard/footprint-sample";
import { writerSpoolDir } from "../blackboard/sessions";
import { acknowledgeClaudeNotices } from "./claude-ack";
import { claudeReturnedInput } from "./claude-input";
import { reduceClaudeRenderEvent } from "./claude-render-state";
import type { LiveClaudeSession } from "./claude-types";
import { observeClaudeCandidates } from "./input-coverage-events";
import type { ThreadContext } from "./thread-context";
import {
	inheritParentFootprint,
	observeForkInheritance,
} from "./thread-inheritance";

/**
 * Route one Claude JSONL line through an explicit render decision and the
 * side-effect owners for footprints, inheritance, notices, and turn lifetime.
 */
export function registerTurnRouter(
	context: ThreadContext,
	id: string,
	session: LiveClaudeSession,
): void {
	const handleLine = (line: string): void => {
		if (!line.trim()) return;
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return;
		}

		const sessionId =
			typeof event.session_id === "string" ? event.session_id : undefined;
		if (sessionId) session.claudeSessionId = sessionId;

		const turn = session.turn;
		if (!turn) {
			if (session.bufferInitialLines && session.initialLines.length < 512) {
				session.initialLines.push(line);
			}
			return;
		}

		if (event.type === "system" && event.subtype === "init") {
			turn.sawInit = true;
		}
		startInheritanceObservation(context, id, session, event);

		if (turn.inputCoverage) observeClaudeCandidates(turn.inputCoverage, event);
		const render = reduceClaudeRenderEvent(turn, event);
		if (render.decision === "undecided") {
			turn.undecidedEventTypes.add(render.decisionKey);
		}
		for (const emitted of render.events) turn.emit(emitted);
		for (const block of render.newToolBlocks) {
			recordToolCallFootprint(id, turn, event, block);
		}
		for (const block of render.toolResultBlocks) {
			recordToolResultFootprint(context, id, turn, block, event);
		}

		if (event.type === "result") {
			handleResult(turn, event);
		}
	};
	context.lineRouters.set(id, handleLine);
}

type Turn = NonNullable<LiveClaudeSession["turn"]>;

function startInheritanceObservation(
	context: ThreadContext,
	id: string,
	session: LiveClaudeSession,
	event: Record<string, unknown>,
): void {
	const turn = session.turn;
	if (
		!turn ||
		(event.type !== "assistant" && event.type !== "result") ||
		turn.inheritanceStarted
	) {
		return;
	}
	turn.inheritanceStarted = true;
	turn.inheritancePromise = (async () => {
		let inherited: { refs: string[]; comparable: boolean } = {
			refs: [],
			comparable: false,
		};
		if (session.agentContextMode === "fork-session" && session.forkPlan) {
			try {
				inherited = await inheritParentFootprint(context, id, session.forkPlan);
			} catch (error) {
				console.error("[chat] fork footprint mirror failed:", error);
			}
		}
		await observeForkInheritance(context, id, "claude", {
			agentContextInherited: session.agentContextMode === "fork-session",
			premiseInherited:
				session.agentContextMode === "fork-session" && inherited.comparable,
			mode: session.agentContextMode,
			refs: inherited.refs,
		});
	})().catch((error) => {
		console.error("[chat] fork inheritance observation failed:", error);
	});
}

function recordToolCallFootprint(
	id: string,
	turn: Turn,
	event: Record<string, unknown>,
	block: Record<string, unknown>,
): void {
	const footprint = extractFootprint(
		{ ...event, message: { content: [block] } },
		id,
	);
	if (!footprint) return;
	turn.pendingFootprints.set(footprint.activity, footprint);
}

function recordToolResultFootprint(
	context: ThreadContext,
	id: string,
	turn: Turn,
	block: Record<string, unknown>,
	event: Record<string, unknown>,
): void {
	const toolCallId = String(block.tool_use_id ?? "");
	if (turn.inputCoverage && !turn.inputCoverage.acceptResult(toolCallId))
		return;
	const footprint = turn.pendingFootprints.get(toolCallId);
	if (!footprint) {
		turn.inputCoverage?.settle(toolCallId, block.is_error === true ? null : []);
		return;
	}
	turn.pendingFootprints.delete(toolCallId);
	if (block.is_error === true) {
		turn.inputCoverage?.settle(toolCallId, null);
		return;
	}
	const returned = claudeReturnedInput(
		context.bb.projectRoot,
		footprint,
		block,
		event,
	);
	turn.fpQueue = turn.fpQueue.then(async () => {
		for (const used of footprint.used) {
			Object.assign(
				used,
				await captureReturnedInput(
					context.bb.projectRoot,
					used.path,
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
		turn.inputCoverage?.settle(toolCallId, footprint.used);
	});
}

function handleResult(turn: Turn, event: Record<string, unknown>): void {
	if (event.subtype === "success" && event.is_error !== true) {
		acknowledgeClaudeNotices(turn);
	}
	const result = typeof event.result === "string" ? event.result : undefined;
	if (
		event.is_error === true ||
		(typeof event.subtype === "string" && event.subtype.startsWith("error"))
	) {
		turn.emit({ type: "error", message: result || "agent 回合执行失败" });
		turn.resolve();
		return;
	}

	turn.resolve();
}
