import type { Blackboard } from "../blackboard";
import type { Checkpoint } from "../types/checkpoint";
import { verificationStalenessReason } from "./verification-binding";

export interface VerificationStatus {
	status:
		| "passed"
		| "approved"
		| "stale"
		| "unknown"
		| "failed"
		| "timeout"
		| "pending"
		| "needs_human"
		| "skipped"
		| "rejected";
	/** Preserve the archived command outcome separately from current validity. */
	result: string | null;
	message: string;
}

/** Read-only projection shared by CLI and restore cards; never reruns a check. */
export async function checkpointVerificationStatus(
	bb: Blackboard,
	cp: Checkpoint,
): Promise<VerificationStatus> {
	const result = cp.verificationResult?.status ?? null;
	const view = (
		status: VerificationStatus["status"],
		message: string,
	): VerificationStatus => ({ status, result, message });
	if (cp.applicationError)
		return view("failed", `应用失败：${cp.applicationError}`);
	if (cp.artifactConsumption?.state === "started")
		return view("unknown", "验收已开始，效果完成未确认");
	if (cp.artifactUseIssue)
		return view("unknown", `产物验收尚未消费：${cp.artifactUseIssue}`);
	if (cp.lifecycle === "rejected") return view("rejected", "人工审查已驳回");
	if (cp.lifecycle === "pending") return view("pending", "检查执行中");
	if (cp.verificationBindingIssue)
		return view("unknown", cp.verificationBindingIssue);
	if (cp.lifecycle === "awaiting_review")
		return view("needs_human", "等待人工审查");
	const approved = cp.verificationBinding?.context?.authority === "human";
	if (!approved && result !== "passed" && result !== "pass") {
		if (result === "failed") return view("failed", "检查失败");
		if (result === "timeout") return view("timeout", "检查超时");
		if (result === "skipped") return view("skipped", "检查已跳过");
		if (result === "needs_human") return view("needs_human", "等待人工审查");
		return view(
			"unknown",
			result ? `未识别的验证结果：${result}` : "无验证结论",
		);
	}
	if (cp.lifecycle !== "verified" && cp.lifecycle !== "applied")
		return view("unknown", "历史检查结果待重新验证");
	const reason = await verificationStalenessReason(bb, cp);
	if (reason) return view("stale", `验证已过期：${reason}`);
	if (!cp.verificationBinding?.context)
		return view("unknown", "历史检查通过，当前有效性未知（绑定不完整）");
	return approved
		? view("approved", "人工审查通过（绑定与当前状态一致，未重新执行自动检查）")
		: view(
				"passed",
				`检查通过（绑定与当前状态一致）；${cp.verificationResult?.evidence?.status === "satisfied" ? `声明范围 ${cp.verificationResult.evidence.counts.passed}/${cp.verificationResult.evidence.counts.total} 通过，报告 ${cp.verificationResult.evidence.reportPath}` : "用例范围未知（未声明报告）"}`,
			);
}
