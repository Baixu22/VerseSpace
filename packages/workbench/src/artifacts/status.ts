import type { Blackboard } from "../blackboard";
import { hashText } from "../hash";
import { verificationStalenessReason } from "../runtime/verification-binding";
import type { Checkpoint } from "../types/checkpoint";
import { type ArtifactFacts, artifactFacts } from "./facts";
import { captureArtifactSnapshot } from "./snapshot";
import { targetCheckIssue, targetRangeUnchanged } from "./target-check";

export interface ArtifactReview {
	rootId: string;
	checkpointId: string;
	path: string;
	source: "declared";
	status: "current" | "stale" | "pending" | "failed" | "unknown";
	targetStatus: "target-checked" | "inputs-match" | "inputs-differ" | "unknown";
	targetCheck?: Checkpoint["artifactTargetCheck"];
	handoff?: {
		digest: string;
		checkpointHash: string;
		originStrength: string;
		targetStatus: string;
	};
	targetNow?: NonNullable<Checkpoint["artifactBinding"]>["target"];
	targetChange?:
		| "none"
		| "outside-declared-range"
		| "revalidation-required"
		| "unknown";
	reason: string;
	inputs: string[];
	origin: Checkpoint["artifactOrigin"];
	inputOrigin?: Checkpoint["artifactInputOrigin"];
	verifiedAt: Checkpoint["artifactBinding"];
	checkedAt?: string;
	writerId?: string;
	threadId?: string;
	refs: string[];
	facts?: ArtifactFacts;
	/** Legacy no-record declarations retain scope-check semantics, not provenance proof. */
	evidenceStrength?: "observed-origin-and-scope" | "declared-scope" | "unknown";
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
			const currentSnapshot = await captureArtifactSnapshot(bb, cp);
			const facts = await artifactFacts(bb, root, cp);
			let status: ArtifactReview["status"] = "unknown";
			let reason = "声明范围、来源或验证绑定不完整";
			if (root.artifactConsumption?.state === "started") {
				status = root.lifecycle === "failed" ? "failed" : "unknown";
				reason = "产物验收已开始但效果完成未确认，需核对恢复记录";
			} else if (cp.artifactUseIssue) {
				reason = `产物验收被拒绝：${cp.artifactUseIssue}`;
			} else if (cp.lifecycle === "draft" || cp.lifecycle === "pending") {
				status = "pending";
				reason = "重验尚未完成";
			} else if (["failed", "rejected"].includes(cp.lifecycle)) {
				status = "failed";
				reason = `最近检查 ${cp.verificationResult?.status ?? cp.lifecycle}`;
			} else if (cp.verificationBindingIssue) {
				reason = cp.verificationBindingIssue;
			} else if (currentSnapshot?.target?.status === "unknown") {
				reason = currentSnapshot.target.reason ?? "目标适用性未知";
			} else if (
				(cp.lifecycle === "verified" || cp.lifecycle === "applied") &&
				cp.artifactBinding &&
				cp.verificationResult?.status === "passed" &&
				cp.verificationResult.evidence?.status === "satisfied" &&
				cp.verificationBinding?.context?.authority === "command"
			) {
				const stale = await verificationStalenessReason(bb, cp);
				status = stale ? "stale" : "current";
				reason = stale ?? "本工位声明产物与输入的检查范围已满足";
				if (
					!stale &&
					root.artifact?.inputRecords &&
					facts.origin.strength !== "tool-observed"
				) {
					status = "unknown";
					reason =
						"所选历史输入来源不是完整工具观察；当前范围检查与来源未知分别保留";
				}
			}
			const targetStatus: ArtifactReview["targetStatus"] =
				status === "current" && cp.artifactTargetCheck && !targetCheckIssue(cp)
					? "target-checked"
					: status === "current" &&
							cp.artifactBinding?.target?.inputsMatch !== undefined
						? cp.artifactBinding.target.inputsMatch
							? "inputs-match"
							: "inputs-differ"
						: "unknown";
			reason +=
				targetStatus === "target-checked"
					? "；显式目标候选已通过声明范围检查（不代表最终 ref 已合入）"
					: targetStatus === "inputs-match"
						? "；声明输入与目标基线相同（未验证合并结果）"
						: targetStatus === "inputs-differ"
							? "；本工位输入不同于目标基线，目标适用性未验证"
							: "；目标适用性未知";
			const targetNow = currentSnapshot?.target;
			const targetBefore = cp.artifactBinding?.target;
			const targetChange: ArtifactReview["targetChange"] =
				!targetNow || targetNow.status === "unknown" || !targetBefore?.commit
					? "unknown"
					: targetNow.commit === targetBefore.commit
						? "none"
						: targetRangeUnchanged(targetBefore, targetNow)
							? "outside-declared-range"
							: "revalidation-required";
			if (targetChange === "outside-declared-range")
				reason += "；目标仅在声明文件范围外推进，未执行范围外检查";
			return {
				rootId: root.id,
				checkpointId: cp.id,
				path: artifact.path,
				source: artifact.source,
				status,
				reason,
				targetStatus,
				targetCheck: cp.artifactTargetCheck,
				handoff: cp.artifactHandoff
					? {
							digest: cp.artifactHandoff.digest,
							checkpointHash: cp.artifactHandoff.context.checkpointHash,
							originStrength: cp.artifactHandoff.origin.strength,
							targetStatus: cp.artifactHandoff.target.status,
						}
					: undefined,
				targetNow,
				targetChange,
				inputs: artifact.inputs,
				origin: root.artifactOrigin,
				inputOrigin: root.artifactInputOrigin,
				verifiedAt: cp.artifactBinding,
				checkedAt: cp.verificationResult?.at,
				writerId: cp.writerId,
				threadId: cp.threadId,
				facts,
				evidenceStrength:
					status !== "current"
						? "unknown"
						: facts.origin.strength === "tool-observed"
							? "observed-origin-and-scope"
							: "declared-scope",
				refs: [
					...new Set([
						root.id,
						cp.id,
						...(cp.artifactHandoff ? [cp.artifactHandoff.digest] : []),
					]),
				],
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
			JSON.stringify([
				review.checkpointId,
				review.status,
				review.reason,
				review.facts,
				review.evidenceStrength,
				review.targetCheck,
				review.targetNow,
				review.targetChange,
				review.handoff,
				review.refs,
			]),
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
