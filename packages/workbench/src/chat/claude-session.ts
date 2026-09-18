import { join } from "node:path";

import { spawnSupervised } from "../supervisor";
import {
	type LivenessVerdict,
	type LivenessWatch,
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
 * TF-0205: what happens when the watch reports something.
 *
 * `stalled` is named but not fatal — the CLI emits nothing during a long tool
 * call, so silence is not evidence of death. `unresponsive` is the terminal
 * call, and the whole point of this node is that it becomes a visible error:
 * before, a wedged CLI ended as a turn that simply never resolved. The child is
 * asked to leave (stdin closed) rather than tree-killed — a caller with a
 * better idea about a wedged CLI can still act on it.
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
	if (verdict.kind === "unresponsive") {
		const seconds = Math.round(verdict.silentMs / 1000);
		turn?.emit({
			type: "error",
			message: `agent 已 ${seconds}s 没有任何输出，判定为无响应；本轮到此结束，可以重试或换一条线程。`,
		});
		try {
			context.live.get(id)?.proc.closeStdin();
		} catch {
			// stdin 已经关了——那正是我们想要的状态
		}
		turn?.resolve();
	}
}
