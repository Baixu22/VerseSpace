import { isAbsolute, join } from "node:path";
import { pendingPremiseNotices } from "../runtime/delivery";
import { decideSeal } from "../runtime/seal";
import {
	HEARTBEAT_INTERVAL_MS,
	type LivenessVerdict,
	type LivenessWatch,
	STALL_MS,
	UNRESPONSIVE_MS,
	watchLiveness,
} from "../supervisor/liveness";
import { type CodexAppServer, createCodexAppServer } from "./codex-app-server";
import type { ThreadContext } from "./thread-context";
import type { ThreadRepository } from "./thread-repository";
import type { ThreadMeta } from "./thread-types";

/**
 * A live codex lane session (TF-0249). Unlike the claude session — which streams
 * stdin/stdout line by line and tracks per-turn liveness — the codex driver is
 * promise-based (`startTurn` resolves on `turn/completed`), so this wrapper is
 * thin: it owns the app-server client and the codex thread id, reused across
 * turns until the thread is idle-closed.
 */
export interface LiveCodexSession {
	server: CodexAppServer;
	/** The codex thread id, minted by the first `thread/start`. */
	codexThreadId: string | null;
	/** stderr tail, surfaced on error. */
	stderr: string;
	/**
	 * The active turn's event sink. The turn runner installs it so the
	 * app-server's `onEvent` reaches this turn's router; cleared between turns so
	 * session-level noise is not routed into a stale turn.
	 */
	route?: (event: Record<string, unknown>) => void;
	/**
	 * The armed idle-close timer. Held on the session (as the claude lane does)
	 * so the next turn can cancel it: a timer left running would shut the
	 * app-server down in the middle of a later turn, and `startTurn` would then
	 * never resolve — the thread's enqueue lock held forever.
	 */
	idleTimer?: ReturnType<typeof setTimeout>;
	/** Silence watch — a live but mute app-server must not wedge a turn. */
	liveness?: LivenessWatch;
	closing?: boolean;
	closed?: Promise<void>;
}

/**
 * Silence windows, read per session (not once at import) so a test can drive a
 * mute child through the hard threshold without idling 135 real seconds — the
 * same shape as the readers in claude-session.ts.
 */
const codexStallMs = () =>
	Number(process.env.WORKBENCH_LIVENESS_STALL_MS) || STALL_MS;
const codexUnresponsiveMs = () =>
	Number(process.env.WORKBENCH_LIVENESS_UNRESPONSIVE_MS) || UNRESPONSIVE_MS;
const codexTickMs = () =>
	Math.max(1, Math.min(HEARTBEAT_INTERVAL_MS, Math.floor(codexStallMs() / 3)));
const codexKillGraceMs = () =>
	Number(process.env.WORKBENCH_LIVENESS_KILL_GRACE_MS) || 5_000;

export async function ensureCodexSession(
	context: ThreadContext,
	id: string,
	meta: ThreadMeta,
): Promise<LiveCodexSession> {
	let existing = context.liveCodex.get(id);
	if (existing?.closing) {
		// The process is already going away (idle-close or cancel). Wait for the
		// exit cleanup, then look again: the next turn must not attach to a
		// corpse whose promises will never settle.
		await existing.closed;
		existing = context.liveCodex.get(id);
	}
	if (existing) return existing;

	let watch: LivenessWatch | null = null;
	const session: LiveCodexSession = {
		server: createCodexAppServer({
			label: `chat:${id}`,
			registryDir: join(context.bb.paths.root, "proc"),
			cwd: context.bb.projectRoot,
			// Every line from the child resets the silence window.
			onActivity: () => watch?.note(),
			onEvent: (event) => {
				context.liveCodex.get(id)?.route?.(event);
			},
			onStderr: (line) => {
				const live = context.liveCodex.get(id);
				if (live) live.stderr += `${line}\n`;
			},
			// TF-0263 option A: the codex write side goes through the same seal
			// point as the Claude Code PreToolUse hook. The writer is this chat
			// lane, and the claims are the same pending premise notices the hook
			// would see. `decideSeal` records every verdict in events.jsonl, so a
			// block here leaves the same audit trail as a block there.
			sealApproval: async (target) => {
				const claims = (await pendingPremiseNotices(context.bb)).flatMap(
					(notice) => notice.claims,
				);
				let blocked = false;
				for (const path of target.paths) {
					const outcome = await decideSeal(context.bb, {
						target: isAbsolute(path)
							? path
							: join(context.bb.projectRoot, path),
						writerId: id,
						claims,
					});
					if (outcome.decision === "block") blocked = true;
				}
				return { blocked };
			},
		}),
		codexThreadId: null,
		stderr: "",
	};
	context.liveCodex.set(id, session);
	context.running.set(id, session.server.proc);

	// TF-0205 / ADR-0017: the app-server is watched from the moment it spawns.
	// A child that is alive but mute — a CLI that never answers `initialize`, a
	// wedged app-server — would otherwise hold the turn (and the thread's
	// enqueue lock) open forever, because nothing else can settle its promises.
	watch = watchLiveness({
		tickMs: codexTickMs(),
		stallMs: codexStallMs(),
		unresponsiveMs: codexUnresponsiveMs(),
		terminate: async () => {
			// Ask the child to leave (stdin EOF is the graceful path), then
			// tree-kill whatever is still there. The exit that follows runs the
			// ordinary cleanup below.
			try {
				session.server.proc.closeStdin();
			} catch {
				// stdin already closed — that is the state we wanted
			}
			await new Promise((resolve) => setTimeout(resolve, codexKillGraceMs()));
			await session.server.proc.kill().catch(() => {});
		},
		onVerdict: (verdict) => reportCodexLiveness(id, session, verdict),
	});
	session.liveness = watch;

	// The handshake is the one part of the session that can fail on its own
	// (missing binary, a CLI that does not speak app-server, a refused login).
	// The session is already in `liveCodex`/`running` so its events can route;
	// if the handshake throws it must be taken back out, or the next turn
	// attaches to a corpse and returns early — leaving the durable thread
	// marked running forever.
	try {
		await context.bb.sessions.register(id, "agent", meta.title);
		await context.bb.sessions.setStatus(id, "active");

		// `codexSessionId` on meta lets a later turn resume the same codex
		// thread (the app-server minted id).
		await session.server.initialize();
		session.codexThreadId = await session.server.startThread({
			cwd: context.bb.projectRoot,
			resume: meta.codexSessionId,
		});
	} catch (error) {
		watch.stop();
		await session.server.shutdown().catch(() => {});
		if (context.liveCodex.get(id) === session) {
			context.liveCodex.delete(id);
		}
		if (context.running.get(id) === session.server.proc) {
			context.running.delete(id);
		}
		throw error;
	}

	// Reap on process exit: return the durable thread to idle.
	session.closed = session.server.proc
		.wait()
		.then(async () => {
			// The child is gone: the authoritative end of the watch.
			watch?.exited("codex app-server 已退出");
			session.closing = true;
			if (session.idleTimer) {
				clearTimeout(session.idleTimer);
				session.idleTimer = undefined;
			}
			await resetCodexThreadToIdle(context.store, id);
			if (context.liveCodex.get(id) === session) {
				context.liveCodex.delete(id);
				context.running.delete(id);
			}
		})
		.catch((error) => {
			console.error(`[chat] codex 线程 ${id} 退出清理失败:`, error);
		});

	return session;
}

/**
 * Return a codex thread's durable meta to `idle`.
 *
 * Both codex exit paths need this — the app-server going away, and a turn that
 * never got a thread id — because `run()` already marked the durable thread
 * running and nothing else resets it.
 *
 * The WRITE failure must not be swallowed. If the reset does not land, the
 * thread stays `status: "running"` forever and every surface keeps showing the
 * busy indicator with no turn behind it. The claude lane treats the same
 * failure as worth reporting (`thread-run.ts`: "线程永远停在 running"), and the
 * two lanes must not disagree about that — so this reports it the same way
 * instead of `.catch(() => {})`.
 */
export async function resetCodexThreadToIdle(
	store: Pick<ThreadRepository, "get" | "saveMeta">,
	id: string,
): Promise<void> {
	const latest = await store.get(id).catch(() => null);
	if (latest?.status !== "running") {
		return;
	}
	latest.status = "idle";
	await store.saveMeta(latest).catch((error) => {
		console.error(
			`[chat] codex 线程 ${id} 出错后无法把状态复位为 idle（线程会一直停在 running）:`,
			error,
		);
	});
}

/**
 * What happens when the watch reports something. `stalled` is named but not
 * fatal — codex legitimately emits nothing during a long tool call. The
 * terminal call is `judged_silent`: the hard threshold fired and `terminate`
 * took the child down. The turn is ended here, with the reason, so the process
 * exit that follows does not report a second, vaguer error.
 */
function reportCodexLiveness(
	id: string,
	session: LiveCodexSession,
	verdict: LivenessVerdict,
): void {
	if (verdict.kind === "stalled") {
		console.warn(
			`[chat] codex 线程 ${id} 已静默 ${Math.round(verdict.silentMs / 1000)}s（可能只是长工具调用）`,
		);
		return;
	}
	if (verdict.kind === "unresponsive" || verdict.kind === "judged_silent") {
		const silence =
			verdict.silentMs < 1000
				? "不到 1s"
				: `${Math.round(verdict.silentMs / 1000)}s`;
		const reason =
			verdict.kind === "judged_silent"
				? `codex app-server 已 ${silence} 没有任何输出，判定为无响应并已强制结束该进程；可以重试或换一条线程。`
				: `codex app-server 已 ${silence} 没有任何输出，判定为无响应；本轮到此结束，可以重试或换一条线程。`;
		// Both paths are needed: `abortTurn` reports into a turn that is already
		// running, `noteTermination` makes the exit reason specific when the
		// verdict lands before any turn exists (a mute handshake).
		session.server.noteTermination(reason);
		session.server.abortTurn(reason);
	}
}
