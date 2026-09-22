import { createCodexRenderState, finalCodexParts } from "./codex-render-state";
import { type CodexTurnState, routeCodexEvent } from "./codex-router";
import { ensureCodexSession } from "./codex-session";
import type { ThreadContext } from "./thread-context";
import { maybePromote } from "./thread-promotion";
import type { StoredMessage, ThreadMeta, TurnRunEvent } from "./thread-types";

/** How long an idle codex session lingers before its process is torn down. */
export const CODEX_SESSION_IDLE_CLOSE_MS =
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
): Promise<void> {
	const session = await ensureCodexSession(context, id, meta);
	if (!session.codexThreadId) {
		emit({ type: "error", message: "codex 线程未能建立" });
		return;
	}

	const turn: CodexTurnState = {
		render: createCodexRenderState(),
		pendingFootprints: new Map(),
		fpQueue: Promise.resolve(),
		undecidedEventTypes: new Set(),
		sawTurnStart: false,
		emit,
	};
	// Install this turn's event sink; the app-server's onEvent routes here.
	session.route = (event) => routeCodexEvent(context, id, turn, event);

	try {
		await session.server.startTurn(session.codexThreadId, text);
	} catch (error) {
		emit({ type: "error", message: `codex 回合执行失败：${String(error)}` });
	} finally {
		session.route = undefined;
	}

	// Finalize: drain footprint hashing, persist the assistant message, update
	// meta, then arm the idle-close timer (same order as the claude lane).
	await turn.fpQueue;
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

	// Idle-close the session so orphaned codex processes don't accumulate.
	if (context.liveCodex.get(id) === session) {
		setTimeout(() => {
			void session.server.shutdown();
		}, CODEX_SESSION_IDLE_CLOSE_MS);
	}
}
