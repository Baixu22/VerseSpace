import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Blackboard } from "../blackboard";
import { derive } from "../blackboard/metrics";
import { acquirePidLock, type PidLock } from "../fs/lockfile";
import {
	crashLoopTripped,
	type ProcHandle,
	spawnSupervised,
} from "../supervisor";
import { envelopes } from "../tribunal/envelopes";
import { shouldSuspend } from "../tribunal/lane-distress";
import { createAgentCapture } from "./capture";
import {
	type AgentSession,
	type AgentStartInput,
	type AgentStartResult,
	writeLatest,
} from "./session";

export {
	type AgentSession,
	type AgentStartResult,
	readLatestSession,
} from "./session";
export { describeStreamLine, readAgentView } from "./view";

/** One batch per workspot, across CLI and HTTP processes. */
export async function startAgent(
	bb: Blackboard,
	input: AgentStartInput,
): Promise<AgentStartResult> {
	const key = createHash("sha256").update(input.workspotId).digest("hex");
	const lease = await acquirePidLock(
		join(bb.paths.root, "locks", "agents", `${key}.lock`),
	);
	if (!lease.acquired)
		return { ok: false, reason: `工位 ${input.workspotId} 已有批处理运行中` };
	let started = false;
	try {
		const result = await startAgentLocked(bb, input, lease);
		started = result.ok;
		return result;
	} finally {
		if (!started) await lease.release();
	}
}

/**
 * Non-interactive agent batch run (the first increment of the agent-session
 * layer): spawn the configured agent CLI inside the workspot worktree with
 * the prompt on stdin, stream its output to a JSONL log under
 * `.workbench/agents/<ws>/` line by line (a long-running agent's log stays
 * readable while it works), and track session status in latest.json.
 *
 * Fire-and-forget: returns as soon as the process spawns; completion lands
 * in latest.json and the event log. The default command is Claude Code's
 * non-interactive stream-json mode; `agent.command` in workbench.yaml
 * overrides it for other CLIs. The spawn goes through the supervisor — pid
 * registry (orphans are reaped on boot) and a crash-loop breaker that stops
 * dispatching an agent that exits abnormally three times in a minute.
 */
async function startAgentLocked(
	bb: Blackboard,
	input: AgentStartInput,
	lease: PidLock,
): Promise<AgentStartResult> {
	const workspot = await bb.state.workspots.get(input.workspotId);
	if (!workspot) {
		return { ok: false, reason: `工位不存在：${input.workspotId}` };
	}
	const config = await bb.config.load();
	const command = config.agent.command;
	const registryDir = join(bb.paths.root, "proc");
	const label = `agent:${workspot.id}`;
	if (crashLoopTripped(registryDir, label)) {
		// OTP-style upgrade abandonment: stop dispatching a crashing agent.
		// issue #6 item 12: the refusal must also surface as a card — otherwise
		// the lane silently stops accepting work and only a generic log line
		// says why. Same causeKey as the trip below, so repeats fold into one.
		await bb.tribunal
			.submit(envelopes.agentCrashloop(workspot.id, label))
			.catch((err) => {
				console.error(
					`[agent] 熔断拒派的裁决卡投递失败（${workspot.id}），队列里看不到它:`,
					err,
				);
			});
		return {
			ok: false,
			reason: `agent 连续崩溃，暂停派发（${label} 在 60 秒内异常退出 3 次）`,
		};
	}
	const currentLane = derive(await bb.metrics.get(workspot.id));
	if (shouldSuspend(currentLane)) {
		await bb.tribunal.submit(
			envelopes.metricSuspend(
				workspot.id,
				Math.max(currentLane.consecutiveFailures, currentLane.compactions),
			),
		);
		return {
			ok: false,
			reason:
				`车道 ${workspot.id} 已挂起（压缩 ${currentLane.compactions} 次 / 连续失败 ${currentLane.consecutiveFailures} 次）。` +
				"从文件系统笔记 + git diff 重播种后再派发。",
		};
	}

	const worktree = isAbsolute(workspot.worktreePath)
		? workspot.worktreePath
		: join(bb.projectRoot, workspot.worktreePath);
	const dir = join(bb.paths.root, "agents", workspot.id);
	await mkdir(dir, { recursive: true });
	const startedAt = new Date().toISOString();
	const logFile = join(
		dir,
		`${startedAt.replace(/[:.]/g, "-")}-${randomUUID()}.jsonl`,
	);
	await writeFile(logFile, "", "utf8");

	const session: AgentSession = {
		workspot: workspot.id,
		agent: command,
		goal: input.goalId ?? workspot.currentTask ?? workspot.primaryTask,
		prompt: input.prompt,
		status: "running",
		startedAt,
		logFile,
	};
	await writeLatest(bb, session);
	await bb.events.append({
		timestamp: new Date().toISOString(),
		source: "agent",
		type: "agent_started",
		payload: { workspotId: workspot.id, goal: session.goal, agent: command },
	});

	// output streams to the JSONL log as lines arrive — nothing accumulates
	// unbounded in memory
	const logLine = (kind: "out" | "err") => (line: string) =>
		appendFile(logFile, `${JSON.stringify({ kind, line })}\n`, "utf8").catch(
			() => {},
		);

	const writerId = `agent:${workspot.id}`;
	await bb.sessions.register(writerId, "agent", command, {
		workspot: workspot.id,
		task: session.goal,
	});
	const capture = await createAgentCapture(bb, writerId, workspot.id, worktree);
	const proc: ProcHandle = spawnSupervised(command, {
		label,
		registryDir,
		cwd: worktree,
		stdin: input.prompt,
		stdinAfterFirstOutput: true,
		onLine: (line, kind) => {
			void logLine(kind)(line);
			if (kind === "out") {
				capture.line(line);
			}
		},
	});

	void proc
		.wait()
		.then(async (outcome) => {
			let captureError: string | undefined;
			try {
				captureError = await capture.finish();
			} catch (error) {
				captureError = `agent 流记录失败：${String(error)}`;
			}
			await bb.sessions.setStatus(writerId, "idle");
			const finished: AgentSession = {
				...session,
				status: outcome.exitCode === 0 && !captureError ? "done" : "failed",
				finishedAt: new Date().toISOString(),
				exitCode: outcome.exitCode,
				error:
					outcome.error ??
					captureError ??
					(outcome.exitCode !== 0 && outcome.exitCode !== null
						? `异常退出（exitCode ${outcome.exitCode}）`
						: undefined),
			};
			if (outcome.exitCode !== 0 && crashLoopTripped(registryDir, label)) {
				finished.error = `agent 连续崩溃，已熔断暂停派发（60 秒内异常退出 3 次）；${finished.error ?? ""}`;
				await bb.events.append({
					timestamp: new Date().toISOString(),
					source: "agent",
					type: "agent_crashloop",
					payload: { workspotId: workspot.id, label },
				});
				// issue #6 item 12: the trip gets its own card so the crash loop is
				// not buried in the activity stream. Folds with the refusal card.
				await bb.tribunal
					.submit(envelopes.agentCrashloop(workspot.id, label))
					.catch((err) => {
						console.error(
							`[agent] 崩溃熔断的裁决卡投递失败（${workspot.id}），队列里看不到它:`,
							err,
						);
					});
			}
			await bb.events.append({
				timestamp: new Date().toISOString(),
				source: "agent",
				type: "agent_finished",
				payload: {
					workspotId: workspot.id,
					status: finished.status,
					exitCode: finished.exitCode,
				},
			});
			// Publish the user-visible terminal state only after its audit event is
			// durable; readers that observe `done` can then safely query the event.
			await writeLatest(bb, finished);
		})
		.finally(() => lease.release())
		.catch((error) => {
			console.error(`[agent] 批处理收尾失败（${workspot.id}）:`, error);
		});

	return { ok: true, logFile };
}
