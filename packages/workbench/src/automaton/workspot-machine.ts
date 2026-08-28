import type { WorldSnapshot } from "../types/snapshot";
import type { Transition } from "../types/transitions";

/**
 * Workspot state machine: idle → active → blocked/borrowed/completed.
 *
 * The automaton only maintains consistency for ACTIVE workspots; assigning
 * idle workspots is the Scheduler's job (dispatch), and returning a released
 * workspot to a fresh context happens through `refresh_context`.
 */
export function evaluateWorkspots(snapshot: WorldSnapshot): Transition[] {
	const transitions: Transition[] = [];
	const goalById = new Map(snapshot.goals.map((goal) => [goal.id, goal]));
	const workspots = [...snapshot.workspots].sort((a, b) =>
		a.id.localeCompare(b.id),
	);

	for (const workspot of workspots) {
		if (workspot.status !== "active") {
			continue;
		}
		const taskId = workspot.currentTask ?? workspot.primaryTask;
		const task = goalById.get(taskId);
		if (!task) {
			transitions.push({
				type: "notify_human",
				message: `工位 ${workspot.id} 指向的目标 ${taskId} 不存在`,
				severity: "error",
			});
			continue;
		}
		if (task.status === "done") {
			transitions.push({
				type: "workspot_status",
				wsId: workspot.id,
				from: "active",
				to: "idle",
				reason: `任务 ${taskId} 已完成，释放工位`,
			});
			transitions.push({
				type: "refresh_context",
				wsId: workspot.id,
			});
		} else if (task.status === "stale_done" || task.status === "cancelled") {
			transitions.push({
				type: "workspot_status",
				wsId: workspot.id,
				from: "active",
				to: "blocked",
				reason: `任务 ${taskId} 已失效（${task.status}），需人工重新指派`,
			});
			transitions.push({
				type: "notify_human",
				message: `工位 ${workspot.id} 被阻塞：任务 ${taskId} ${task.status}`,
				severity: "warning",
			});
		}
	}
	return transitions;
}
