import type { Checkpoint } from "./checkpoint";
import type { Goal } from "./goal";
import type { RegistryEntry } from "./interface-registry";
import type { Workspot } from "./workspot";

/** 预留导出（契约面）：当前无生产引用，保留为公共 API（issue #4，2026-09-13）。 */
export type CheckpointZone = "staging" | "verified" | "failed";

export interface ZoneCheckpoints {
	staging: Checkpoint[];
	verified: Checkpoint[];
	failed: Checkpoint[];
}

/**
 * Automaton input (skeleton section 六): one consistent read of everything the
 * state machines may look at. Assembled by the Blackboard, never mutated.
 */
export interface WorldSnapshot {
	goals: Goal[];
	checkpoints: ZoneCheckpoints;
	interfaces: RegistryEntry[];
	/** Missing canonical files observed by the Blackboard; never persisted as entries. */
	missingInterfaces?: string[];
	workspots: Workspot[];
	executionQueue: string[];
}
