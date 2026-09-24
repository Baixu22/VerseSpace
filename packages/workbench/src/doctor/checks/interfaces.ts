import type { Blackboard } from "../../blackboard";
import type { DoctorContext, DoctorIssue } from "../types";

export async function checkInterfaces(
	bb: Blackboard,
	ctx: DoctorContext,
	issues: DoctorIssue[],
): Promise<void> {
	const { interfaces, workspots } = ctx;
	// ── interfaces: hash drift and dangling subscribers ──
	for (const entry of interfaces) {
		const report = await bb.interfaces.checkDrift(entry.key);
		if (report.missing) {
			issues.push({
				check: "missing_interface_file",
				severity: "error",
				message: `接口 ${entry.key} 的契约文件 ${entry.canonicalPath} 不存在`,
				subject: entry.key,
			});
		} else if (report.drifted) {
			issues.push({
				check: "interface_drift",
				// P0-3: this is the product's own thesis — a recorded premise no
				// longer holds. Leaving it at `warning` meant `doctor` exited 0
				// while a contract had silently moved, which made the "CI gate"
				// claim in AGENTS.md false in the one case it mattered most.
				severity: "error",
				message: `接口 ${entry.key} 的内容与注册 hash 不一致（sync 将重锚定并可能触发下游 stale）`,
				subject: entry.key,
			});
		}
		for (const subscriber of entry.subscribers) {
			if (!workspots.some((ws) => ws.id === subscriber.workspot)) {
				issues.push({
					check: "dangling_subscriber",
					severity: "warning",
					message: `接口 ${entry.key} 的订阅者工位 ${subscriber.workspot} 不存在`,
					subject: entry.key,
				});
			}
		}
	}
}
