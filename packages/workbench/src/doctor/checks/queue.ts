import type { DoctorContext, DoctorIssue } from "../types";

export function checkQueue(ctx: DoctorContext, issues: DoctorIssue[]): void {
	const { goals, queue } = ctx;
	// ── queue: entries must be ready goals; duplicates are corruption ──
	const seen = new Set<string>();
	for (const goalId of queue) {
		if (seen.has(goalId)) {
			issues.push({
				check: "duplicate_queue_entry",
				severity: "error",
				message: `执行队列中目标 ${goalId} 重复出现（队列文件可能被手工编辑）`,
				subject: goalId,
			});
		}
		seen.add(goalId);
		const goal = goals.find((candidate) => candidate.id === goalId);
		if (!goal) {
			issues.push({
				check: "dangling_queue_entry",
				severity: "error",
				message: `执行队列引用不存在的目标 ${goalId}（sync 或清理 state/queue/ 条目文件）`,
				subject: goalId,
			});
		} else if (goal.status !== "ready") {
			issues.push({
				check: "stale_queue_entry",
				severity: "warning",
				message: `执行队列中的目标 ${goalId} 状态为 ${goal.status}，不再是 ready`,
				subject: goalId,
			});
		}
	}
}
