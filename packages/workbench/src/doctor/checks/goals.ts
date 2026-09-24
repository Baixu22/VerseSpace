import type { DoctorContext, DoctorIssue } from "../types";

export function checkGoals(ctx: DoctorContext, issues: DoctorIssue[]): void {
	const { goals, interfaces, staging, verified, failed, goalIds } = ctx;
	// ── goals: DAG integrity ──
	for (const goal of goals) {
		for (const dep of goal.dependsOn) {
			if (!goalIds.has(dep)) {
				issues.push({
					check: "dangling_dependency",
					severity: "error",
					message: `目标 ${goal.id} 依赖不存在的目标 ${dep}（从 dependsOn 中移除或补建目标）`,
					subject: goal.id,
				});
			}
		}
		// declared checkpoints must exist somewhere
		const knownCheckpoints = new Set(
			[...staging, ...verified, ...failed].map((cp) => cp.id),
		);
		for (const cpId of goal.checkpoints) {
			if (!knownCheckpoints.has(cpId)) {
				issues.push({
					check: "dangling_checkpoint_reference",
					severity: "warning",
					message: `目标 ${goal.id} 引用的 checkpoint ${cpId} 在任何分区都找不到（可能被手工删除）`,
					subject: goal.id,
				});
			}
		}
		// drift anchors: interface must exist and be at the anchored version
		for (const [key, version] of Object.entries(
			goal.verifiedAgainst.interfaces,
		)) {
			const entry = interfaces.find((candidate) => candidate.key === key);
			if (!entry) {
				issues.push({
					check: "unknown_interface_anchor",
					severity: "warning",
					message: `目标 ${goal.id} 锚定的接口 ${key} 不在注册表中`,
					subject: goal.id,
				});
			} else if (entry.version < version) {
				issues.push({
					check: "registry_version_regression",
					severity: "error",
					message: `接口 ${key} 注册表版本（v${entry.version}）低于目标 ${goal.id} 的锚定版本（v${version}），注册表可能被手工改坏`,
					subject: key,
				});
			}
		}
	}
}
