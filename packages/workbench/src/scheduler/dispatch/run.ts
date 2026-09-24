import type { Blackboard } from "../../blackboard";
import type { SchedulerPolicy } from "../../types/config";
import type { SchedulerNotify } from "../notifications";
import { type DispatchDecision, type SchedulerState, tick } from "../tick";
import { dispatchGoal } from "./goal";
import type { DispatchResult } from "./types";

/** Scheduler stage for the Runtime: tick and execute what policy allows. */
export async function runScheduler(
	bb: Blackboard,
	policy: Exclude<SchedulerPolicy, "manual">,
	maxConcurrentWorkspots: number,
	notify: SchedulerNotify,
): Promise<DispatchResult[]> {
	const state: SchedulerState = {
		policy,
		queue: await bb.state.queue.get(),
		goals: await bb.goals.list(),
		workspots: await bb.state.workspots.list(),
		maxConcurrentWorkspots,
	};
	const decisions: DispatchDecision[] = tick(state);
	const results: DispatchResult[] = [];

	for (const decision of decisions) {
		if (decision.type === "notify_human") {
			await notify(decision.message, decision.severity, decision.tribunal);
			continue;
		}
		if (decision.type === "dispatch") {
			const result = await dispatchGoal(
				bb,
				decision.goalId,
				decision.workspotId,
				{ notify },
			);
			results.push(result);
		}
	}
	return results;
}
