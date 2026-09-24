import type { DoctorContext, DoctorIssue } from "../types";

export function checkCheckpoints(
	ctx: DoctorContext,
	issues: DoctorIssue[],
): void {
	const { workspots, staging, verified, failed, goalIds } = ctx;
	// ── checkpoints: orphans and zone/lifecycle mismatch ──
	for (const [zone, checkpoints, allowed] of [
		[
			"staging",
			staging,
			["draft", "pending", "verified", "failed", "awaiting_review", "rejected"],
		],
		["verified", verified, ["verified", "applied"]],
		["failed", failed, ["failed", "rejected"]],
	] as const) {
		for (const checkpoint of checkpoints) {
			if (!(allowed as readonly string[]).includes(checkpoint.lifecycle)) {
				issues.push({
					check: "checkpoint_zone_mismatch",
					severity: "error",
					message: `checkpoint ${checkpoint.id} 的 ${checkpoint.lifecycle} 状态不属于 ${zone} 分区`,
					subject: checkpoint.id,
				});
			}
		}
	}
	for (const checkpoint of [...staging, ...verified, ...failed]) {
		if (!goalIds.has(checkpoint.goal)) {
			issues.push({
				check: "orphan_checkpoint",
				severity: "error",
				message: `checkpoint ${checkpoint.id} 指向不存在的目标 ${checkpoint.goal}（删除该文件或补建目标）`,
				subject: checkpoint.id,
			});
		}
		if (!workspots.some((ws) => ws.id === checkpoint.workspot)) {
			issues.push({
				check: "orphan_checkpoint_workspot",
				severity: "warning",
				message: `checkpoint ${checkpoint.id} 指向不存在的工位 ${checkpoint.workspot}`,
				subject: checkpoint.id,
			});
		}
	}
}
