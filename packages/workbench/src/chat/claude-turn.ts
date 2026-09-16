import { ensureClaudeSession } from "./claude-session";
import type { ActiveTurn } from "./claude-types";
import { promptWithNotices, turnLine } from "./prompt";
import type { ThreadContext } from "./thread-context";
import { maybePromote } from "./thread-promotion";
import type { RunEvent, StoredMessage, ThreadMeta } from "./thread-types";

export const SESSION_IDLE_CLOSE_MS =
	Number(process.env.WORKBENCH_SESSION_IDLE_MS) || 5 * 60_000;

export async function runClaudeTurn(
	context: ThreadContext,
	id: string,
	meta: ThreadMeta,
	text: string,
	emit: (event: RunEvent) => void,
	opts: {
		resend: boolean;
		precedingNotices: string[];
		onNoticesSent?: () => Promise<boolean>;
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
		assistantTexts: [],
		messageParts: [],
		stderr: "",
		pendingFootprints: new Map(),
		fpQueue: Promise.resolve(),
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
	// Unfinished tool calls remain in the transcript, never in the read/write
	// ledger. A result-less attempt is not proof that a tool ran.
	turn.pendingFootprints.clear();
	const full = turn.assistantTexts.join("");
	if (full || turn.messageParts.some((part) => part.type === "tool-call")) {
		const assistantMessage: StoredMessage = {
			id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			role: "assistant",
			text: full,
			at: new Date().toISOString(),
			parts: turn.messageParts,
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
