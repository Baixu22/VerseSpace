import type { Blackboard } from "../blackboard";
import type { Checkpoint } from "../types/checkpoint";
import { captureBindingForCheckpoint } from "./verification-binding";

export interface ReviewOutcome {
	ok: boolean;
	id: string;
	verdict: "verified" | "rejected";
	reason?: string;
}

/**
 * Human review of an `awaiting_review` checkpoint (the GUI and
 * `workbench checkpoint review` share this). Approve → verified zone;
 * reject → failed zone.
 */
export async function reviewCheckpoint(
	bb: Blackboard,
	cpId: string,
	approve: boolean,
): Promise<ReviewOutcome> {
	const staging = await bb.checkpoints.scanZone("staging");
	const checkpoint = staging.find((cp) => cp.id === cpId);
	if (!checkpoint) {
		return {
			ok: false,
			id: cpId,
			verdict: approve ? "verified" : "rejected",
			reason: `staging 区找不到 checkpoint：${cpId}`,
		};
	}
	if (checkpoint.lifecycle !== "awaiting_review") {
		return {
			ok: false,
			id: cpId,
			verdict: approve ? "verified" : "rejected",
			reason: `checkpoint ${cpId} 处于 ${checkpoint.lifecycle}，只有 awaiting_review 需要人工审查`,
		};
	}
	const verdict: Checkpoint["lifecycle"] = approve ? "verified" : "rejected";
	// 人工审查通过同样是关于「审查时那份代码」的声明：批准时一并采集验证绑定，
	// verified→applied 之前会重新确认，代码其后变化则退回重验
	// （verification-binding.ts）。采集不可用时不能批准为当前有效。
	const binding = approve
		? await captureBindingForCheckpoint(bb, checkpoint)
		: undefined;
	if (approve && !binding) {
		return {
			ok: false,
			id: cpId,
			verdict,
			reason: "当前工作区代码状态未知，无法批准；请恢复可读的 Git 工作区后重试",
		};
	}
	await bb.checkpoints.save(
		{
			...checkpoint,
			lifecycle: verdict,
			verificationBinding: binding,
			verificationBindingIssue: undefined,
		},
		"staging",
	);
	await bb.checkpoints.move(cpId, "staging", approve ? "verified" : "failed");
	await bb.events.append({
		timestamp: new Date().toISOString(),
		source: "human",
		type: approve ? "checkpoint_approved" : "checkpoint_rejected",
		payload: { cpId },
	});
	return { ok: true, id: cpId, verdict };
}
