import type { WorldSnapshot } from "../types/snapshot";
import type { Transition } from "../types/transitions";
import { evaluateCheckpoints } from "./checkpoint-machine";
import { evaluateGoals } from "./goal-machine";
import { evaluateWorkspots } from "./workspot-machine";

/**
 * The Automaton (skeleton section 三): a pure, stateless function from the
 * current world snapshot to the list of transitions needed to make the world
 * consistent.
 *
 * Invariants:
 * - no IO: it never reads or writes files, never spawns processes;
 * - deterministic: stable iteration order (goals, checkpoints, workspots,
 *   each sorted by id), so the same snapshot always yields the same list;
 * - idempotent: evaluating an already-consistent snapshot returns [].
 */
export function evaluate(snapshot: WorldSnapshot): Transition[] {
	return [
		...evaluateGoals(snapshot),
		...evaluateCheckpoints(snapshot),
		...evaluateWorkspots(snapshot),
	];
}
