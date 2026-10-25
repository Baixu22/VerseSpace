import {
	createInputCoverage,
	recordInputCoverage,
} from "../blackboard/input-coverage";
import { createCodexRenderState, finalCodexParts } from "./codex-render-state";
import { type CodexTurnState, routeCodexEvent } from "./codex-router";
import { ensureCodexSession, resetCodexThreadToIdle } from "./codex-session";
import type { ThreadContext } from "./thread-context";
import { maybePromote } from "./thread-promotion";
import type { StoredMessage, ThreadMeta, TurnRunEvent } from "./thread-types";

/**
 * How long an idle codex session lingers before its process is torn down.
 * Read per turn (not once at import) so a test can drive the idle-close race
 * with a short window instead of idling five real minutes — the same shape as
 * `chatStallMs()` in claude-session.ts.
 */
export const codexSessionIdleCloseMs = (): number =>
	Number(process.env.WORKBENCH_SESSION_IDLE_MS) || 5 * 60_000;

/**
 * Run one codex turn (TF-0249). Mirrors `runClaudeTurn`'s shape — ensure a
 * session, drive one turn, then finalize footprints / message / meta — but the
 * codex driver is promise-based, so the turn is bounded by `startTurn`
 * resolving on `turn/completed` rather than by a stdin-streamed result frame.
 */
export async function runCodexTurn(
	context: ThreadContext,
	id: string,
	meta: ThreadMeta,
	text: string,
	emit: (event: TurnRunEvent) => void,
	opts: { messageId: string },
): Promise<boolean> {
	const session = await ensureCodexSession(context, id, meta);
	// The session outlives the turn; cancel the idle-close armed by the previous
	// turn. Without this the timer can fire mid-turn and kill the app-server,
	// leaving `startTurn` — and therefore this thread's enqueue lock — pending
	// forever. The claude lane clears `session.idleTimer` at exactly this point.
	if (session.idleTimer) {
		clearTimeout(session.idleTimer);
		session.idleTimer = undefined;
	}
	if (!session.codexThreadId) {
		emit({ type: "error", message: "codex 线程未能建立" });
		// `run()` already marked the durable thread running; returning without
		// resetting it left the thread busy forever (a second turn then deadlocks
		// behind the same enqueue lock). The reset itself reports its own
		// write failure — swallowing it here would hide a thread stuck at
		// `running`, which is the same failure the claude lane refuses to hide.
		await resetCodexThreadToIdle(context.store, id);
		return false;
	}

	const turn: CodexTurnState = {
		render: createCodexRenderState(),
		pendingFootprints: new Map(),
		fpQueue: Promise.resolve(),
		inputCoverage: createInputCoverage(),
		undecidedEventTypes: new Set(),
		emit,
	};
	// Install this turn's event sink; the app-server's onEvent routes here.
	let completed = false;
	let failed = false;
	session.route = (event) => {
		if (event.type === "error") failed = true;
		if (event.type === "turn/completed") {
			completed =
				(event.turn as { status?: string } | undefined)?.status === "completed";
		}
		routeCodexEvent(context, id, turn, event);
	};

	try {
		await session.server.startTurn(session.codexThreadId, text);
	} catch (error) {
		failed = true;
		emit({ type: "error", message: `codex 回合执行失败：${String(error)}` });
	} finally {
		session.route = undefined;
	}

	// Finalize: drain footprint hashing, persist the assistant message, update
	// meta, then arm the idle-close timer (same order as the claude lane).
	await turn.fpQueue;
	await recordInputCoverage(
		context.bb,
		id,
		turn.inputCoverage!.finish(),
		opts.messageId,
	);
	turn.pendingFootprints.clear();
	if (turn.undecidedEventTypes.size > 0) {
		console.warn(
			`[chat] codex 线程 ${id} 有未建模的流事件类型：${[...turn.undecidedEventTypes].join(", ")}`,
		);
	}

	const parts = finalCodexParts(turn.render);
	const full = parts
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("");
	if (full || parts.some((part) => part.type !== "text")) {
		const assistantMessage: StoredMessage = {
			id: opts.messageId,
			role: "assistant",
			text: full,
			at: new Date().toISOString(),
			parts,
		};
		await context.store.appendMessage(id, assistantMessage);
		emit({ type: "done", message: assistantMessage });
	}

	const latest = await context.store.get(id);
	latest.status = "idle";
	latest.codexSessionId = session.codexThreadId ?? latest.codexSessionId;
	await context.store.saveMeta(latest);
	await maybePromote(context, id);

	// Idle-close the session so orphaned codex processes don't accumulate. Held
	// on the session so the next turn can cancel it (see the top of this file).
	if (context.liveCodex.get(id) === session) {
		session.idleTimer = setTimeout(() => {
			void session.server.shutdown();
		}, codexSessionIdleCloseMs());
	}
	return completed && !failed;
}
