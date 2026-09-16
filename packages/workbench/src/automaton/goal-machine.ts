import { envelopes } from "../tribunal/envelopes";
import type { Goal } from "../types/goal";
import type { WorldSnapshot } from "../types/snapshot";
import type { Transition } from "../types/transitions";
import {
	currentGoalStatus,
	incompleteDependencies,
	staleGoalReason,
} from "./goal-validity";

/**
 * Goal state machine: planned → ready → in_progress → done, with done →
 * stale_done on interface drift and cancelled as a human-only terminal state.
 *
 * Design decisions (documented per the skeleton's extension points):
 * - a dependency is satisfied only by `done`; `stale_done` and `cancelled`
 *   deliberately block downstream goals (a broken anchor invalidates derived
 *   work), surfaced as notify_human warnings instead of silent readiness.
 * - a goal completes only after a checkpoint's declared effects are applied;
 *   being in the verified directory alone is not proof of completion.
 *
 * R3: each notify_human carries a `tribunal` envelope, because this machine is
 * the only place that knows which goal is stuck and what unsticks it. The
 * message stays for logs and the CLI; the envelope is what the adjudication
 * queue rationalizes.
 */
export function evaluateGoals(snapshot: WorldSnapshot): Transition[] {
	const transitions: Transition[] = [];
	const byId = new Map(snapshot.goals.map((goal) => [goal.id, goal]));
	const goals = [...snapshot.goals].sort((a, b) => a.id.localeCompare(b.id));

	const deadDependencies = (goal: Goal) =>
		goal.dependsOn
			.map((id) => byId.get(id))
			.filter((dep): dep is Goal => dep !== undefined)
			.map((dep) => ({ ...dep, status: currentGoalStatus(dep, snapshot) }))
			.filter(
				(dep) => dep.status === "stale_done" || dep.status === "cancelled",
			);

	for (const goal of goals) {
		switch (goal.status) {
			case "planned": {
				const blockers = incompleteDependencies(goal, snapshot);
				if (blockers.length === 0) {
					transitions.push({
						type: "goal_status",
						goalId: goal.id,
						from: "planned",
						to: "ready",
						reason: "所有依赖已完成",
					});
					break;
				}
				const missing = blockers.filter((id) => !byId.has(id));
				if (missing.length > 0) {
					transitions.push({
						type: "notify_human",
						message: `目标 ${goal.id} 依赖的目标不存在：${missing.join(", ")}`,
						severity: "error",
						tribunal: envelopes.missingDependency(goal.id, missing),
					});
				}
				const dead = deadDependencies(goal);
				if (dead.length > 0) {
					transitions.push({
						type: "notify_human",
						message: `目标 ${goal.id} 无法就绪：依赖 ${dead
							.map((dep) => `${dep.id}(${dep.status})`)
							.join(", ")} 已失效`,
						severity: "warning",
						tribunal: envelopes.deadDependency(
							goal.id,
							"planned",
							dead.map((dep) => ({ id: dep.id, status: dep.status })),
						),
					});
				}
				break;
			}
			case "ready": {
				const blockers = incompleteDependencies(goal, snapshot);
				const dead = deadDependencies(goal);
				if (dead.length > 0) {
					transitions.push({
						type: "notify_human",
						message: `就绪目标 ${goal.id} 的依赖已失效：${dead
							.map((dep) => `${dep.id}(${dep.status})`)
							.join(", ")}；派发前请先处理`,
						severity: "warning",
						tribunal: envelopes.deadDependency(
							goal.id,
							"ready",
							dead.map((dep) => ({ id: dep.id, status: dep.status })),
						),
					});
				}
				if (blockers.length > 0) {
					transitions.push({
						type: "goal_status",
						goalId: goal.id,
						from: "ready",
						to: "planned",
						reason: `依赖尚未有效完成：${blockers.join(", ")}`,
					});
					break;
				}
				const workedOn = snapshot.workspots.some(
					(ws) =>
						ws.status === "active" &&
						(ws.currentTask ?? ws.primaryTask) === goal.id,
				);
				if (workedOn) {
					transitions.push({
						type: "goal_status",
						goalId: goal.id,
						from: "ready",
						to: "in_progress",
						reason: "工位已开始施工",
					});
				}
				// 已经在施工的目标不进队列：它不是在等派发。此前这里无条件入队，
				// 于是「派发（出队）→ 下一轮同步（入队）→ 再下一轮（出队）」来回
				// 抖动，两次同步之间 doctor 会看到「队列里的目标不再是 ready」的
				// 假警告（2026-09-13 收尾 §3.2 观察①）。
				if (!workedOn && !snapshot.executionQueue.includes(goal.id)) {
					transitions.push({ type: "enqueue_goal", goalId: goal.id });
				}
				break;
			}
			case "in_progress": {
				const verified = snapshot.checkpoints.verified.some(
					(cp) => cp.goal === goal.id && cp.lifecycle === "applied",
				);
				if (verified && incompleteDependencies(goal, snapshot).length === 0) {
					transitions.push({
						type: "goal_status",
						goalId: goal.id,
						from: "in_progress",
						to: "done",
						reason: "checkpoint 已验证且效果已应用",
					});
				}
				break;
			}
			case "done": {
				const reason = staleGoalReason(goal, snapshot);
				if (reason)
					transitions.push({ type: "mark_stale", goalId: goal.id, reason });
				break;
			}
			case "stale_done":
			case "cancelled":
				// terminal: only human action (re-plan / re-verify) revives work
				break;
		}
	}

	// queue consistency: entries whose goal is no longer ready are drained
	// (dispatch dequeues too, but a goal that completes/cancels while queued
	// would otherwise linger forever). The judgement uses the *post-transition*
	// status: a goal that leaves `ready` in this same pass must not linger in
	// the queue, or doctor (which reads the queue between two syncs) reports a
	// false `stale_queue_entry` until the next pass drains it.
	const nextStatus = new Map<string, Goal["status"]>();
	for (const transition of transitions) {
		if (transition.type === "goal_status") {
			nextStatus.set(transition.goalId, transition.to);
		}
	}
	for (const goalId of snapshot.executionQueue) {
		const goal = byId.get(goalId);
		if (goal && (nextStatus.get(goalId) ?? goal.status) !== "ready") {
			transitions.push({ type: "dequeue_goal", goalId });
		}
	}
	return transitions;
}
