import type { WorldSnapshot } from "../types/snapshot";
import type { Blackboard } from "./index";

/**
 * One consistent read of everything the automaton needs. Composed from the
 * data-layer APIs; deliberately not cached — each call re-reads from disk so
 * concurrent CLI invocations always see current state.
 */
export async function getWorldSnapshot(bb: Blackboard): Promise<WorldSnapshot> {
	const [goals, checkpoints, interfaces, workspots, executionQueue] =
		await Promise.all([
			bb.goals.list(),
			bb.checkpoints.scanAll(),
			bb.interfaces.list(),
			bb.state.workspots.list(),
			bb.state.queue.get(),
		]);
	return { goals, checkpoints, interfaces, workspots, executionQueue };
}
