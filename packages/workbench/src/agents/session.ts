import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blackboard } from "../blackboard";
import { writeFileAtomic } from "../fs/atomic";

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
	logFile: string;
}

export interface AgentStartInput {
	workspotId: string;
	prompt: string;
	goalId?: string;
}

export interface AgentStartResult {
	ok: boolean;
	reason?: string;
	logFile?: string;
}

function latestFile(bb: Blackboard, id: string): string {
	return join(bb.paths.root, "agents", id, "latest.json");
}

export async function writeLatest(
	bb: Blackboard,
	session: AgentSession,
): Promise<void> {
	await writeFileAtomic(
		latestFile(bb, session.workspot),
		JSON.stringify(session, null, 2),
	);
}

export async function readLatestSession(
	bb: Blackboard,
	id: string,
): Promise<AgentSession | null> {
	try {
		return JSON.parse(
			await readFile(latestFile(bb, id), "utf8"),
		) as AgentSession;
	} catch {
		return null;
	}
}
