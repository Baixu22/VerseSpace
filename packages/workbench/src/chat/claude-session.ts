import { join } from "node:path";

import { spawnSupervised } from "../supervisor";
import { registerTurnRouter } from "./claude-router";
import type { LiveClaudeSession } from "./claude-types";
import type { ThreadContext } from "./thread-context";
import type { ThreadMeta } from "./thread-types";

export const CHAT_COMMAND_DEFAULT =
	"claude -p --verbose --output-format stream-json --include-partial-messages";

export const chatCommand = () =>
	process.env.WORKBENCH_CHAT_COMMAND ?? CHAT_COMMAND_DEFAULT;

export async function ensureClaudeSession(
	context: ThreadContext,
	id: string,
	meta: ThreadMeta,
	firstTurnLines: string[],
): Promise<LiveClaudeSession> {
	const existing = context.live.get(id);
	if (existing) {
		return existing;
	}
	const claudeSessionId: string | undefined = meta.claudeSessionId;
	const forkPlan =
		!meta.hasResumableSession &&
		meta.forkOf?.agentContextPlan?.provider === "claude"
			? meta.forkOf.agentContextPlan
			: undefined;
	let agentContextMode: LiveClaudeSession["agentContextMode"] = "fresh";
	let commandLine = chatCommand();
	if (meta.permissionMode !== "default") {
		commandLine += ` --permission-mode ${meta.permissionMode}`;
	}
	// streaming input keeps the session alive across turns; the first
	// turn mints the session id (--session-id), respawns resume it
	commandLine += " --input-format stream-json";
	if (forkPlan) {
		// Claude creates a new provider session while inheriting the parent's
		// transcript/context. This is deliberately limited to a tail fork.
		commandLine += ` --resume ${forkPlan.sourceSessionId} --fork-session`;
		agentContextMode = "fork-session";
	} else if (claudeSessionId) {
		commandLine += meta.hasResumableSession
			? ` --resume ${claudeSessionId}`
			: ` --session-id ${claudeSessionId}`;
	}

	const initialLines: string[] = [];
	const proc = spawnSupervised(commandLine, {
		label: `chat:${id}`,
		registryDir: join(context.bb.paths.root, "proc"),
		cwd: context.bb.projectRoot,
		stdin: firstTurnLines.join("\n"),
		keepStdinOpen: true,
		stdinGate: (line) => line.includes('"subtype":"init"'),
		onLine: (line, kind) => {
			if (kind === "out") {
				const router = context.lineRouters.get(id);
				if (router) {
					router(line);
				} else if (initialLines.length < 512) {
					// The child can emit its init line before the router is installed.
					// Keep a bounded startup buffer rather than dropping the first turn.
					initialLines.push(line);
				}
			} else {
				const turn = context.live.get(id)?.turn;
				if (turn) {
					turn.stderr += `${line}\n`;
				}
			}
		},
	});
	context.running.set(id, proc);
	const session: LiveClaudeSession = {
		proc,
		claudeSessionId,
		turn: null,
		initialLines,
		bufferInitialLines: true,
		agentContextMode,
		forkPlan,
	};
	context.live.set(id, session);
	registerTurnRouter(context, id, session);
	await context.bb.sessions.register(id, "agent", meta.title);
	await context.bb.sessions.setStatus(id, "active");

	// reap on exit: cleanup happens once per process lifetime
	session.closed = proc
		.wait()
		.then(async () => {
			session.closing = true;
			const active = session.turn;
			try {
				if (active) {
					await active.fpQueue;
					active.pendingFootprints.clear();
				}
				const latest = await context.store.get(id);
				if (latest.status === "running") {
					latest.status = "idle";
					await context.store.saveMeta(latest);
				}
			} finally {
				active?.resolve();
				if (session.idleTimer) clearTimeout(session.idleTimer);
				if (context.live.get(id) === session) {
					context.live.delete(id);
					context.running.delete(id);
				}
			}
		})
		.catch((error) => {
			console.error(`[chat] 线程 ${id} 退出清理失败:`, error);
		});
	return session;
}
