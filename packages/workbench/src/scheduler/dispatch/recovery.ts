import type { Blackboard } from "../../blackboard";

/**
 * TF-0203: repair workspots left mid-dispatch by a crash.
 *
 * An `initializing` workspot is invisible to the rest of the system: the
 * scheduler only dispatches `idle` ones and the automaton only maintains
 * `active` ones, so without this the row would wait for a human. Called at the
 * start of every cycle, under the run lock.
 *
 * The checkout is deliberately left alone. If phase 2 completed before the
 * crash the worktree is real and this workspot is its owner — the next
 * dispatch reuses it (createWorktree is idempotent and the branch-occupancy
 * pre-check accepts the workspot's own checkout, TF-0202).
 */
export async function recoverInterruptedDispatches(
	bb: Blackboard,
): Promise<string[]> {
	const stuck = (await bb.state.workspots.list())
		.filter((workspot) => workspot.status === "initializing")
		.sort((a, b) => a.id.localeCompare(b.id));
	const recovered: string[] = [];
	for (const workspot of stuck) {
		await bb.state.workspots.save({
			...workspot,
			status: "idle",
			currentTask: undefined,
			binding: "primary",
		});
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "scheduler",
			type: "dispatch_recovered",
			payload: {
				workspotId: workspot.id,
				branch: workspot.branch,
				worktree: workspot.worktreePath,
			},
		});
		recovered.push(workspot.id);
	}
	return recovered;
}
