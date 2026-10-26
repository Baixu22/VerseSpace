import type { Checkpoint } from "./checkpoint";
import type { Goal } from "./goal";
import type { RegistryEntry } from "./interface-registry";
import type { Workspot } from "./workspot";

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
