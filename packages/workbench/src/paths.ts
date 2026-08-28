import { join } from "node:path";
import { pathExists } from "./fs/atomic";

export interface WorkbenchPaths {
	/** The `.workbench/` directory itself. */
	root: string;
	config: string;
	blackboard: string;
	goals: string;
	decisions: string;
	interfaces: string;
	registry: string;
	state: string;
	workspots: string;
	queue: string;
	conflicts: string;
	checkpoints: string;
	staging: string;
	verified: string;
	failed: string;
	eventsDir: string;
	eventsFile: string;
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
		registry: join(blackboard, "interfaces", "registry.yaml"),
		state,
		workspots: join(state, "workspots"),
		queue: join(state, "queue.yaml"),
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
	let current = startDir;
	for (;;) {
		const candidate = join(current, ".workbench");
		if (await pathExists(candidate)) {
			return candidate;
		}
		const parent = join(current, "..");
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}
