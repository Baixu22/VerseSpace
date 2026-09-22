import { join } from "node:path";
import { type CodexAppServer, createCodexAppServer } from "./codex-app-server";
import type { ThreadContext } from "./thread-context";
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
	closing?: boolean;
	closed?: Promise<void>;
}

export async function ensureCodexSession(
	context: ThreadContext,
	id: string,
	meta: ThreadMeta,
): Promise<LiveCodexSession> {
	const existing = context.liveCodex.get(id);
	if (existing) return existing;

	const session: LiveCodexSession = {
		server: createCodexAppServer({
			label: `chat:${id}`,
			registryDir: join(context.bb.paths.root, "proc"),
			cwd: context.bb.projectRoot,
			onEvent: (event) => {
				context.liveCodex.get(id)?.route?.(event);
			},
			onStderr: (line) => {
				const live = context.liveCodex.get(id);
				if (live) live.stderr += `${line}\n`;
			},
		}),
		codexThreadId: null,
		stderr: "",
	};
	context.liveCodex.set(id, session);
	context.running.set(id, session.server.proc);

	await context.bb.sessions.register(id, "agent", meta.title);
	await context.bb.sessions.setStatus(id, "active");

	// Handshake + open the thread. `codexSessionId` on meta lets a later turn
	// resume the same codex thread (the app-server minted id).
	await session.server.initialize();
	session.codexThreadId = await session.server.startThread({
		cwd: context.bb.projectRoot,
		resume: meta.codexSessionId,
	});

	// Reap on process exit: return the durable thread to idle.
	session.closed = session.server.proc
		.wait()
		.then(async () => {
			session.closing = true;
			const latest = await context.store.get(id).catch(() => null);
			if (latest && latest.status === "running") {
				latest.status = "idle";
				await context.store.saveMeta(latest).catch(() => {});
			}
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
