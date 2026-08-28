import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Blackboard } from "../blackboard";

export interface AgentSession {
	workspot: string;
	agent: string;
	goal?: string;
	prompt: string;
	status: "running" | "done" | "failed";
	startedAt: string;
	finishedAt?: string;
	exitCode?: number | null;
	error?: string;
	/** Path to the stream log (JSONL of {kind, line}). */
	logFile: string;
}

export interface AgentStartResult {
	ok: boolean;
	reason?: string;
	logFile?: string;
}

function agentsRoot(bb: Blackboard): string {
	return join(bb.paths.root, "agents");
}

function latestFile(bb: Blackboard, workspotId: string): string {
	return join(agentsRoot(bb), workspotId, "latest.json");
}

async function writeLatest(
	bb: Blackboard,
	session: AgentSession,
): Promise<void> {
	await mkdir(join(agentsRoot(bb), session.workspot), { recursive: true });
	await writeFile(
		latestFile(bb, session.workspot),
		JSON.stringify(session, null, 2),
		"utf8",
	);
}

/** Read the most recent agent session for a workspot, if any. */
export async function readLatestSession(
	bb: Blackboard,
	workspotId: string,
): Promise<AgentSession | null> {
	try {
		const raw = await readFile(latestFile(bb, workspotId), "utf8");
		return JSON.parse(raw) as AgentSession;
	} catch {
		return null;
	}
}

/**
 * Non-interactive agent batch run (the first increment of the agent-session
 * layer): spawn the configured agent CLI inside the workspot worktree with
 * the prompt on stdin, capture its stream output to a JSONL log under
 * `.workbench/agents/<ws>/`, and track session status in latest.json.
 *
 * Fire-and-forget: returns as soon as the process spawns; completion lands
 * in latest.json and the event log. The default command is Claude Code's
 * non-interactive stream-json mode; `agent.command` in workbench.yaml
 * overrides it for other CLIs.
 */
export async function startAgent(
	bb: Blackboard,
	input: { workspotId: string; prompt: string; goalId?: string },
): Promise<AgentStartResult> {
	const workspot = await bb.state.workspots.get(input.workspotId);
	if (!workspot) {
		return { ok: false, reason: `工位不存在：${input.workspotId}` };
	}
	const config = await bb.config.load();
	const command = config.agent.command;

	const worktree = isAbsolute(workspot.worktreePath)
		? workspot.worktreePath
		: join(bb.projectRoot, workspot.worktreePath);
	const dir = join(agentsRoot(bb), workspot.id);
	await mkdir(dir, { recursive: true });
	const startedAt = new Date().toISOString();
	const logFile = join(dir, `${startedAt.replace(/[:.]/g, "-")}.jsonl`);
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

	const child = spawn(command, { cwd: worktree, shell: true });
	let output = "";
	const capture = (_kind: "out" | "err") => (chunk: Buffer) => {
		output += chunk.toString("utf8");
	};
	child.stdout?.on("data", capture("out"));
	child.stderr?.on("data", capture("err"));

	child.stdin?.write(input.prompt);
	child.stdin?.end();

	child.on("close", async (exitCode) => {
		const lines = output.split("\n").filter((line) => line.trim().length > 0);
		for (const line of lines) {
			await appendFile(
				logFile,
				`${JSON.stringify({ kind: "out", line })}\n`,
				"utf8",
			);
		}
		const finished: AgentSession = {
			...session,
			status: exitCode === 0 ? "done" : "failed",
			finishedAt: new Date().toISOString(),
			exitCode,
		};
		await writeLatest(bb, finished);
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "agent",
			type: "agent_finished",
			payload: { workspotId: workspot.id, status: finished.status, exitCode },
		});
	});
	child.on("error", async (error) => {
		const finished: AgentSession = {
			...session,
			status: "failed",
			finishedAt: new Date().toISOString(),
			error: String(error),
		};
		await writeLatest(bb, finished);
	});

	return { ok: true, logFile };
}

/** Pull the human-visible text out of one captured stream line. */
export function describeStreamLine(raw: string): string {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (parsed.type === "assistant" && typeof parsed.message === "object") {
			const message = parsed.message as {
				content?: Array<{ type?: string; text?: string }>;
			};
			const text = (message.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join(" ")
				.trim();
			if (text) {
				return text;
			}
		}
		if (parsed.type === "result") {
			return `结果：${String(parsed.result ?? parsed.subtype ?? "")}`;
		}
		return String(parsed.type ?? raw.slice(0, 80));
	} catch {
		return raw.slice(0, 120);
	}
}

/** Session + the last few human-readable stream lines, for the lane card. */
export async function readAgentView(
	bb: Blackboard,
	workspotId: string,
): Promise<{ session: AgentSession | null; lastLines: string[] }> {
	const session = await readLatestSession(bb, workspotId);
	if (!session) {
		return { session: null, lastLines: [] };
	}
	let lastLines: string[] = [];
	try {
		const raw = await readFile(session.logFile, "utf8");
		const lines = raw
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.slice(-5)
			.map((line) => {
				try {
					const parsed = JSON.parse(line) as { kind?: string; line?: string };
					return describeStreamLine(parsed.line ?? "");
				} catch {
					return line.slice(0, 120);
				}
			});
		lastLines = lines;
	} catch {
		// log not written yet (process still starting)
	}
	return { session, lastLines };
}
