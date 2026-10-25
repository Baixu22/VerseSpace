import {
	createInputCoverage,
	recordInputCoverage,
} from "../blackboard/input-coverage";
import {
	createClaudeRenderState,
	finalClaudeParts,
} from "./claude-render-state";
import { ensureClaudeSession } from "./claude-session";
import type { ActiveTurn } from "./claude-types";
import { promptWithNotices, turnLine } from "./prompt";
import type { ThreadContext } from "./thread-context";
import { maybePromote } from "./thread-promotion";
import type { StoredMessage, ThreadMeta, TurnRunEvent } from "./thread-types";

export const SESSION_IDLE_CLOSE_MS =
	Number(process.env.WORKBENCH_SESSION_IDLE_MS) || 5 * 60_000;

export async function runClaudeTurn(
	context: ThreadContext,
	id: string,
	meta: ThreadMeta,
	text: string,
	emit: (event: TurnRunEvent) => void,
	opts: {
		resend: boolean;
		precedingNotices: string[];
		onNoticesSent?: () => Promise<boolean>;
		/** TF-0207: the id this turn's streaming events already announced. */
		messageId: string;
	},
): Promise<void> {
	const userTurn = turnLine(promptWithNotices(text, opts.precedingNotices));
	let existing = context.live.get(id);
	if (existing?.closing) {
		await existing.closed;
		existing = context.live.get(id);
	}
	const session =
		existing ?? (await ensureClaudeSession(context, id, meta, [userTurn]));
	if (session.idleTimer) {
		clearTimeout(session.idleTimer);
		session.idleTimer = undefined;
	}

	// per-turn state; the session-level line router fills it
	let resolveTurn!: () => void;
	const turnPromise = new Promise<void>((resolve) => {
		resolveTurn = resolve;
	});
	const turn: ActiveTurn = {
		...createClaudeRenderState(),
		undecidedEventTypes: new Set(),
		stderr: "",
		pendingFootprints: new Map(),
		fpQueue: Promise.resolve(),
		inputCoverage: createInputCoverage(),
		sawInit: false,
		finished: false,
		noticeAcked: opts.precedingNotices.length === 0,
		noticeAckPromise: Promise.resolve(),
		noticeCount: opts.precedingNotices.length,
		onNoticesSent: opts.onNoticesSent,
		inheritanceStarted: false,
		inheritancePromise: Promise.resolve(),
		emit,
		resolve: () => {
			if (!turn.finished) {
				turn.finished = true;
				resolveTurn();
			}
		},
	};
	session.turn = turn;
	if (existing) {
		try {
			session.proc.writeStdin(userTurn);
		} catch (error) {
			// TF-0205: a failed write to a child that is still around is the
			// pipe-break signal — name it here so it is a reported outcome
			// rather than only a raw exception in one turn's error message.
			session.liveness?.pipeBroken(String(error));
			emit({
				type: "error",
				message: `agent stdin 不可写：${String(error)}`,
			});
			turn.resolve();
		}
	} else {
		// The first line was queued by ensureClaudeSession. Replay any output
		// that raced the turn attachment before waiting for the result.
		session.bufferInitialLines = false;
		for (const line of session.initialLines.splice(0)) {
			context.lineRouters.get(id)?.(line);
		}
	}

	// the turn ends when the CLI reports this turn's result (or the
	// session dies) — the child itself stays alive for the next turn
	void session.proc.wait().then((outcome) => {
		if (!turn.finished) {
			if (outcome.error) {
				emit({
					type: "error",
					message: `agent 进程错误：${outcome.error}`,
				});
			} else if (!outcome.killed && outcome.exitCode !== 0) {
				emit({
					type: "error",
					message: `agent 退出码 ${outcome.exitCode}（会话已结束）`,
				});
			}
			turn.resolve();
		}
	});
	await turnPromise;

	// finalize the turn: footprints, messages, meta
	// the child stays alive between turns, but the turn is over — detach
	// it so session-level noise stops being routed and reload/fork see an
	// idle thread (SESSION_IDLE_CLOSE_MS keeps the child for minutes)
	session.turn = null;
	await turn.fpQueue;
	await turn.inheritancePromise;
	await turn.noticeAckPromise;
	await recordInputCoverage(
		context.bb,
		id,
		turn.inputCoverage!.finish(),
		opts.messageId,
	);
	// Unfinished tool calls remain in the transcript, never in the read/write
	// ledger. A result-less attempt is not proof that a tool ran.
	turn.pendingFootprints.clear();
	if (turn.undecidedEventTypes.size > 0) {
		// An event shape the router has no render decision for is a coverage gap.
		// It must be audible here — the alternative is output that quietly never
		// appears after a provider upgrade.
		console.warn(
			`[chat] 线程 ${id} 有未建模的流事件类型：${[...turn.undecidedEventTypes].join(", ")}`,
		);
	}
	const full = turn.messageParts
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("");
	const parts = finalClaudeParts(turn);
	if (full || turn.messageParts.some((part) => part.type === "tool-call")) {
		const assistantMessage: StoredMessage = {
			// TF-0207: persisted under the id the streaming events announced, so
			// a client that rendered the stream already holds the real id.
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
	latest.claudeSessionId = session.claudeSessionId ?? latest.claudeSessionId;
	latest.hasResumableSession = turn.sawInit || latest.hasResumableSession;
	if (latest.permissionMode === "acceptEdits") {
		latest.permissionMode = "default";
	}
	await context.store.saveMeta(latest);

	// 完成的轮次边界：评估加法式晋升（TF-0092）
	await maybePromote(context, id);

	// the session lives on between turns; close it after idle so orphaned
	// children don't accumulate (it exits cleanly via stdin close)
	if (context.live.get(id) === session) {
		session.idleTimer = setTimeout(() => {
			session.proc.closeStdin();
		}, SESSION_IDLE_CLOSE_MS);
	}
}
