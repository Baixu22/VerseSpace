import { join } from "node:path";

import { spawnSupervised } from "../supervisor";
import {
	HEARTBEAT_INTERVAL_MS,
	type LivenessVerdict,
	type LivenessWatch,
	STALL_MS,
	UNRESPONSIVE_MS,
	watchLiveness,
} from "../supervisor/liveness";
import { registerTurnRouter } from "./claude-router";
import type { LiveClaudeSession } from "./claude-types";
import { capabilitiesOf } from "./provider-capabilities";
import type { ThreadContext } from "./thread-context";
import type { ThreadMeta } from "./thread-types";

export const CHAT_COMMAND_DEFAULT =
	"claude -p --verbose --output-format stream-json --include-partial-messages";

export const chatCommand = () =>
	process.env.WORKBENCH_CHAT_COMMAND ?? CHAT_COMMAND_DEFAULT;

/**
 * TF-0200 follow-up: the silence windows are read per run (not once at import)
 * so a test can drive a frozen child through the hard threshold without idling
 * 135 real seconds. Same shape as SESSION_IDLE_CLOSE_MS in claude-turn.ts.
 */
const chatStallMs = () =>
	Number(process.env.WORKBENCH_LIVENESS_STALL_MS) || STALL_MS;
const chatUnresponsiveMs = () =>
	Number(process.env.WORKBENCH_LIVENESS_UNRESPONSIVE_MS) || UNRESPONSIVE_MS;
/** Check rhythm. At the default stall window this is exactly the 15s heartbeat
 *  (STALL_MS is 3× it); a shortened stall window for a test shortens the tick
 *  with it, instead of leaving the check longer than the window it measures. */
const chatTickMs = () =>
	Math.max(1, Math.min(HEARTBEAT_INTERVAL_MS, Math.floor(chatStallMs() / 3)));
/** How long a judged-silent child gets to leave on its own after stdin closes,
 *  before the whole process tree is taken down. */
const chatKillGraceMs = () =>
	Number(process.env.WORKBENCH_LIVENESS_KILL_GRACE_MS) || 5_000;

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
	// TF-0204: the plan records the provider that produced it; ask that
	// provider's capabilities instead of comparing its name here.
	const agentPlan = meta.forkOf?.agentContextPlan;
	const forkPlan =
		!meta.hasResumableSession &&
		agentPlan !== undefined &&
		capabilitiesOf(agentPlan.provider).supportsFork
			? agentPlan
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
	// TF-0205: the child is watched from the moment it spawns. Every output line
	// resets the silence window; the exit handler below closes the watch, so an
	// ordinary end of session never reports as unresponsive. `watch` is assigned
	// right after spawn because onLine can fire before that assignment.
	let watch: LivenessWatch | null = null;
	const proc = spawnSupervised(commandLine, {
		label: `chat:${id}`,
		registryDir: join(context.bb.paths.root, "proc"),
		cwd: context.bb.projectRoot,
		stdin: firstTurnLines.join("\n"),
		keepStdinOpen: true,
		stdinGate: (line) => line.includes('"subtype":"init"'),
		onLine: (line, kind) => {
			watch?.note();
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
	watch = watchLiveness({
		tickMs: chatTickMs(),
		stallMs: chatStallMs(),
		unresponsiveMs: chatUnresponsiveMs(),
		// TF-0200 follow-up: naming the silence was not enough. Observed three
		// times on 2026-09-19 — a wedged CLI ignores stdin EOF, so closing
		// stdin (the old terminal action) left the turn open forever. The hard
		// threshold now escalates: ask the child to leave, then tree-kill
		// whatever is still there. That settles the handle, so the ordinary
		// exit cleanup runs (error event + status back to idle).
		terminate: async () => {
			try {
				proc.closeStdin();
			} catch {
				// stdin 已经关了——那正是我们想要的状态
			}
			await new Promise((resolve) => setTimeout(resolve, chatKillGraceMs()));
			// Idempotent: a child that left during the grace has already
			// settled the handle, which makes this a no-op.
			await proc.kill().catch(() => {});
		},
		onVerdict: (verdict) => {
			void reportLiveness(context, id, verdict);
		},
	});
	context.running.set(id, proc);
	const session: LiveClaudeSession = {
		proc,
		liveness: watch,
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
			// The child is gone: this is the authoritative end of the watch, and
			// the ordinary way a session stops being interesting.
			watch?.exited("agent 进程已退出");
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

/**
 * TF-0205 / TF-0200 follow-up: what happens when the watch reports something.
 *
 * `stalled` is named but not fatal — the CLI emits nothing during a long tool
 * call, so silence is not evidence of death. The terminal call is
 * `judged_silent`: the hard threshold fired and the `terminate` action wired
 * above took the child down. (`unresponsive` is the same silence with no
 * terminate wired, kept for report-only callers.) The whole point of this node
 * is that the terminal call becomes a visible error: before, a wedged CLI
 * ended as a turn that simply never resolved.
 *
 * An ordinary exit is not reported: the event log is for things that need
 * explaining, and "the agent finished" is not one of them. The exception is an
 * exit that follows a broken pipe, because that combination says the pipe
 * failure was real after all.
 */
async function reportLiveness(
	context: ThreadContext,
	id: string,
	verdict: LivenessVerdict,
): Promise<void> {
	const turn = context.live.get(id)?.turn ?? null;
	const unremarkable = verdict.kind === "exited" && !verdict.afterPipeBreak;
	if (!unremarkable) {
		await context.bb.events
			.append({
				timestamp: new Date().toISOString(),
				source: "chat",
				type: "agent_liveness",
				payload: { threadId: id, ...verdict },
			})
			.catch(() => {});
	}
	if (verdict.kind === "stalled") {
		console.warn(
			`[chat] 线程 ${id} 的 agent 已静默 ${Math.round(verdict.silentMs / 1000)}s（可能只是长工具调用）`,
		);
		return;
	}
	if (verdict.kind === "unresponsive" || verdict.kind === "judged_silent") {
		const seconds = Math.round(verdict.silentMs / 1000);
		turn?.emit({
			type: "error",
			message:
				verdict.kind === "judged_silent"
					? `agent 已 ${seconds}s 没有任何输出，判定为无响应并已强制结束该进程；可以重试或换一条线程。`
					: `agent 已 ${seconds}s 没有任何输出，判定为无响应；本轮到此结束，可以重试或换一条线程。`,
		});
		try {
			context.live.get(id)?.proc.closeStdin();
		} catch {
			// stdin 已经关了——那正是我们想要的状态
		}
		turn?.resolve();
	}
}
