import type { Checkpoint, CheckpointLifecycle } from "../types/checkpoint";
import type { Goal } from "../types/goal";
import type { RegistryEntry } from "../types/interface-registry";
import type { WorldSnapshot } from "../types/snapshot";
import type { Workspot, WorkspotStatus } from "../types/workspot";

export function emptySnapshot(): WorldSnapshot {
	return {
		goals: [],
		checkpoints: { staging: [], verified: [], failed: [] },
		interfaces: [],
		workspots: [],
		executionQueue: [],
	};
}

export function snapshotWith(partial: Partial<WorldSnapshot>): WorldSnapshot {
	return { ...emptySnapshot(), ...partial };
}

export function mkGoal(overrides: Partial<Goal> & { id: string }): Goal {
	return {
		title: overrides.id,
		status: "planned",
		acceptance: [],
		dependsOn: [],
		checkpoints: [],
		verifiedAgainst: { interfaces: {}, decisions: [] },
		...overrides,
		version: overrides.version ?? 0,
	};
}

export function mkCheckpoint(
	id: string,
	lifecycle: CheckpointLifecycle,
	goal = "g-1",
): Checkpoint {
	return {
		id,
		goal,
		workspot: "ws-a",
		timestamp: "2026-08-28T00:00:00.000Z",
		lifecycle,
		assertion: "tests green",
		artifacts: [],
		unblocks: [],
	};
}

export function mkWorkspot(
	id: string,
	status: WorkspotStatus,
	taskId: string,
	extra: Partial<Workspot> = {},
): Workspot {
	return {
		id,
		branch: `ws/${id}`,
		worktreePath: `../${id}`,
		primaryTask: taskId,
		binding: "primary",
		status,
		contextNeeds: { decisions: [], interfaces: [] },
		...extra,
	};
}

export function mkEntry(key: string, version: number): RegistryEntry {
	return {
		key,
		canonicalPath: `contracts/${key}.md`,
		version,
		publishedBy: "ws-a",
		lastModified: "2026-08-28T00:00:00.000Z",
		contentHash: `hash-v${version}`,
		subscribers: [],
	};
}
