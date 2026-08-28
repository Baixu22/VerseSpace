import type { Blackboard } from "../blackboard";
import type { Checkpoint } from "../types/checkpoint";

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
	await bb.checkpoints.save({ ...checkpoint, lifecycle: verdict }, "staging");
	await bb.checkpoints.move(cpId, "staging", approve ? "verified" : "failed");
	await bb.events.append({
		timestamp: new Date().toISOString(),
		source: "human",
		type: approve ? "checkpoint_approved" : "checkpoint_rejected",
		payload: { cpId },
	});
	return { ok: true, id: cpId, verdict };
}
