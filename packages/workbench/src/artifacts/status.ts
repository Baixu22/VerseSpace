import type { Blackboard } from "../blackboard";
import { hashText } from "../hash";
import { verificationStalenessReason } from "../runtime/verification-binding";
import type { Checkpoint } from "../types/checkpoint";

export interface ArtifactReview {
	rootId: string;
	checkpointId: string;
	path: string;
	source: "declared";
	status: "current" | "stale" | "pending" | "failed" | "unknown";
	targetStatus: "inputs-match" | "inputs-differ" | "unknown";
	reason: string;
	inputs: string[];
	origin: Checkpoint["artifactOrigin"];
	verifiedAt: Checkpoint["artifactBinding"];
	checkedAt?: string;
	writerId?: string;
	threadId?: string;
	refs: string[];
}

/** Immutable checkpoint history + current files; reading never acknowledges a task. */
export async function listArtifactReviews(
	bb: Blackboard,
	writer?: string,
): Promise<ArtifactReview[]> {
	const all = Object.values(await bb.checkpoints.scanAll()).flat();
	const roots = all.filter(
		(cp) =>
			cp.artifact &&
			!cp.revalidates &&
			(!writer || cp.writerId === writer || cp.threadId === writer),
	);
	return Promise.all(
		roots.map(async (root) => {
			const cp = [
				root,
				...all.filter((entry) => entry.revalidates === root.id),
			].sort(
				(a, b) =>
					b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id),
			)[0]!;
			const artifact = cp.artifact!;
			let status: ArtifactReview["status"] = "unknown";
			let reason = "声明范围、来源或验证绑定不完整";
			if (cp.lifecycle === "draft" || cp.lifecycle === "pending") {
				status = "pending";
				reason = "重验尚未完成";
			} else if (["failed", "rejected"].includes(cp.lifecycle)) {
				status = "failed";
				reason = `最近检查 ${cp.verificationResult?.status ?? cp.lifecycle}`;
			} else if (cp.verificationBindingIssue) {
				reason = cp.verificationBindingIssue;
			} else if (
				cp.artifactBinding &&
				cp.verificationResult?.status === "passed" &&
				cp.verificationResult.evidence?.status === "satisfied" &&
				cp.verificationBinding?.context?.authority === "command"
			) {
				const stale = await verificationStalenessReason(bb, cp);
				status = stale ? "stale" : "current";
				reason = stale ?? "本工位声明产物与输入的检查范围已满足";
			}
			const targetStatus =
				status === "current" &&
				cp.artifactBinding?.target?.inputsMatch !== undefined
					? cp.artifactBinding.target.inputsMatch
						? "inputs-match"
						: "inputs-differ"
					: "unknown";
			reason +=
				targetStatus === "inputs-match"
					? "；声明输入与目标基线相同（未验证合并结果）"
					: targetStatus === "inputs-differ"
						? "；本工位输入不同于目标基线，目标适用性未验证"
						: "；目标适用性未知";
			return {
				rootId: root.id,
				checkpointId: cp.id,
				path: artifact.path,
				source: artifact.source,
				status,
				reason,
				targetStatus,
				inputs: artifact.inputs,
				origin: root.artifactOrigin,
				verifiedAt: cp.artifactBinding,
				checkedAt: cp.verificationResult?.at,
				writerId: cp.writerId,
				threadId: cp.threadId,
				refs: [...new Set([root.id, cp.id])],
			};
		}),
	);
}

/** Independent validity events; never undo applied facts or replay effects. */
export async function reconcileArtifacts(bb: Blackboard): Promise<void> {
	const previous = new Map<string, string>();
	for (const event of await bb.events.query({ type: "artifact_validity" })) {
		const payload = event.payload as { rootId?: string; signature?: string };
		if (payload.rootId && payload.signature)
			previous.set(payload.rootId, payload.signature);
	}
	for (const review of await listArtifactReviews(bb)) {
		const signature = hashText(
			JSON.stringify([review.checkpointId, review.status, review.reason]),
		);
		if (previous.get(review.rootId) === signature) continue;
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type: "artifact_validity",
			payload: { ...review, signature },
		});
	}
}
