import { join } from "node:path";
import { pathExists } from "./fs/atomic";

export interface WorkbenchPaths {
	/** The `.workbench/` directory itself. */
	root: string;
	config: string;
	blackboard: string;
	goals: string;
	decisions: string;
	/** Directory of anchored interface files (the registry lives inside it). */
	interfaces: string;
	/** Directory holding one file per registered interface entry. */
	registry: string;
	state: string;
	workspots: string;
	/** Directory holding one file per queued goal (one entry, one file). */
	queue: string;
	/**
	 * R3: the adjudication queue — one file per item awaiting (or recording)
	 * a human decision. Reads stay possible while a decision is pending.
	 */
	tribunal: string;
	/** Per-writer registration + footprint logs (R1: writers as citizens). */
	sessions: string;
	conflicts: string;
	checkpoints: string;
	staging: string;
	verified: string;
	failed: string;
	eventsDir: string;
	eventsFile: string;
	/** R3 / TF-0084: one usage file per lane. */
	metrics: string;
}

export function workbenchPaths(workbenchRoot: string): WorkbenchPaths {
	const blackboard = join(workbenchRoot, "blackboard");
	const state = join(blackboard, "state");
	const checkpoints = join(workbenchRoot, "checkpoints");
	const eventsDir = join(workbenchRoot, "events");
	return {
		root: workbenchRoot,
		config: join(workbenchRoot, "workbench.yaml"),
		blackboard,
		goals: join(blackboard, "goals"),
		decisions: join(blackboard, "decisions"),
		interfaces: join(blackboard, "interfaces"),
		registry: join(blackboard, "interfaces", "registry"),
		state,
		workspots: join(state, "workspots"),
		queue: join(state, "queue"),
		tribunal: join(state, "tribunal"),
		sessions: join(blackboard, "sessions"),
		metrics: join(state, "metrics"),
		conflicts: join(state, "conflicts.yaml"),
		checkpoints,
		staging: join(checkpoints, "staging"),
		verified: join(checkpoints, "verified"),
		failed: join(checkpoints, "failed"),
		eventsDir,
		eventsFile: join(eventsDir, "events.jsonl"),
	};
}

/**
 * Walk up from `startDir` (or cwd) until a `.workbench/` directory is found,
 * mirroring git's discovery behavior. Returns null when none is found.
 */
export async function findWorkbenchRoot(
	startDir = process.cwd(),
): Promise<string | null> {
	return walkUpFor(startDir, ".workbench");
}

/**
 * Nearest git root. Context-rot scans instruction files from here so
 * `workbench doctor` run inside a package still sees the repo's AGENTS.md.
 */
export async function findGitRoot(
	startDir = process.cwd(),
): Promise<string | null> {
	return walkUpFor(startDir, ".git");
}

async function walkUpFor(
	startDir: string,
	name: string,
): Promise<string | null> {
	let current = startDir;
	for (;;) {
		if (await pathExists(join(current, name))) {
			return current;
		}
		const parent = join(current, "..");
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}
