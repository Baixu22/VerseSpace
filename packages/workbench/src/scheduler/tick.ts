import { envelopes } from "../tribunal/envelopes";
import type { SchedulerPolicy } from "../types/config";
import type { Goal } from "../types/goal";
import type { TribunalEnvelope } from "../types/tribunal";
import type { Workspot } from "../types/workspot";

export interface SchedulerState {
	policy: SchedulerPolicy;
	/** Waiting goal ids (state/queue/ entry files, seq = FIFO priority). */
	queue: string[];
	goals: Goal[];
	workspots: Workspot[];
	maxConcurrentWorkspots: number;
}

export type DispatchDecision =
	| { type: "dispatch"; goalId: string; workspotId: string }
	| {
			type: "notify_human";
			message: string;
			severity: "info" | "warning" | "error";
			/** R3: structured envelope for the adjudication queue. */
			tribunal?: TribunalEnvelope;
	  }
	| { type: "noop" };

/**
 * The Scheduler (skeleton module 4): one pure tick over the current queue,
 * goals, and workspots.
 *
 * - manual: always noop — humans drive via `workbench dispatch`;
 * - semi-auto: suggests the dispatch instead of executing it;
 * - auto: pairs ready goals (queue order) with idle workspots while the
 *   active-workspot count stays under maxConcurrentWorkspots.
 *
 * No queues, no middleware: the "queue" is one YAML file per entry in state/queue/.
 */
export function tick(state: SchedulerState): DispatchDecision[] {
	if (state.policy === "manual") {
		return [];
	}
	const byId = new Map(state.goals.map((goal) => [goal.id, goal]));
	const ready = state.queue
		.map((id) => byId.get(id))
		.filter((goal): goal is Goal => goal?.status === "ready");
	const staleEntries = state.queue.filter(
		(id) => byId.get(id)?.status !== "ready",
	);
	const idle = state.workspots
		.filter((ws) => ws.status === "idle")
		.sort((a, b) => a.id.localeCompare(b.id));

	const decisions: DispatchDecision[] = [];
	if (staleEntries.length > 0) {
		decisions.push({
			type: "notify_human",
			message: `执行队列里有 ${staleEntries.length} 个已失效的条目（${staleEntries.join(", ")}），建议清理`,
			severity: "warning",
			tribunal: envelopes.staleQueueEntries(staleEntries),
		});
	}
	if (ready.length === 0) {
		return decisions;
	}
	if (idle.length === 0) {
		decisions.push({
			type: "notify_human",
			message: `${ready.length} 个就绪目标等待派发，但没有空闲工位`,
			severity: state.policy === "semi-auto" ? "info" : "warning",
			tribunal: envelopes.noIdleWorkspot(ready.length),
		});
		return decisions;
	}

	if (state.policy === "semi-auto") {
		decisions.push({
			type: "notify_human",
			message: `有 ${ready.length} 个就绪目标可以派发（例如：workbench dispatch ${ready[0]?.id} ${idle[0]?.id}）`,
			severity: "info",
			tribunal: envelopes.dispatchSuggestion(
				ready[0]?.id ?? "",
				idle[0]?.id ?? "",
			),
		});
		return decisions;
	}

	// auto: greedily fill idle workspots within the concurrency cap
	const slots =
		state.maxConcurrentWorkspots -
		state.workspots.filter((ws) => ws.status === "active").length;
	if (slots <= 0) {
		decisions.push({
			type: "notify_human",
			message: `已达并发上限（${state.maxConcurrentWorkspots}），${ready.length} 个就绪目标等待空闲工位`,
			severity: "warning",
			// deliberately graded below the queue's soft floor: hitting the
			// configured cap is a capacity signal, not an alarm
			tribunal: envelopes.concurrencyCap(
				state.maxConcurrentWorkspots,
				ready.length,
			),
		});
		return decisions;
	}
	const pairs = Math.min(ready.length, idle.length, slots);
	for (let i = 0; i < pairs; i++) {
		decisions.push({
			type: "dispatch",
			goalId: ready[i]!.id,
			workspotId: idle[i]!.id,
		});
	}
	return decisions;
}
