import type { DoctorContext, DoctorIssue } from "../types";

export function checkWorkspots(
	ctx: DoctorContext,
	issues: DoctorIssue[],
): void {
	const { goals, workspots, goalIds } = ctx;
	// ── workspots: task references and queue/status contradictions ──
	for (const workspot of workspots) {
		// TF-0203: the workspot is mid-dispatch — phase 1 wrote the row, phase 2
		// (the checkout) was never confirmed. Not an error: `runOnce` puts it
		// back to idle. Reported because it means a cycle was interrupted, and
		// because the checkout may or may not exist depending on where it died.
		if (workspot.status === "initializing") {
			issues.push({
				check: "interrupted_dispatch",
				severity: "warning",
				message: `工位 ${workspot.id} 停在中途创建（dispatch 未完成；sync 会把它恢复为 idle）`,
				subject: workspot.id,
			});
		}
		const taskId = workspot.currentTask ?? workspot.primaryTask;
		if (!goalIds.has(taskId)) {
			issues.push({
				check: "dangling_workspot_task",
				severity: "error",
				message: `工位 ${workspot.id} 指向不存在的目标 ${taskId}（ws reassign 或删除工位）`,
				subject: workspot.id,
			});
		} else if (workspot.status === "active") {
			const task = goals.find((goal) => goal.id === taskId);
			if (
				task &&
				(task.status === "cancelled" || task.status === "stale_done")
			) {
				// the automaton will emit the block transition on next sync; doctor
				// surfaces it as informational context for the human
				issues.push({
					check: "active_on_dead_task",
					severity: "warning",
					message: `工位 ${workspot.id} 活跃于已失效目标 ${taskId}（${task.status}）——sync 将阻塞该工位`,
					subject: workspot.id,
				});
			}
		}
	}
}
