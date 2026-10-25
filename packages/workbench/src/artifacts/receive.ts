import type { Blackboard } from "../blackboard";
import { workspotWorktreePath } from "../runtime/verification-binding";
import type { Checkpoint } from "../types/checkpoint";
import { decodeArtifactManifest } from "./manifest-codec";
import {
	checkReceivedArtifact,
	type ReceivedArtifactReview,
} from "./receive-check";
import { revalidateArtifact } from "./revalidate";
import { listArtifactReviews } from "./status";

/** Evidence may request comparison; only the receiver's existing local policy can execute. */
export async function receiveArtifactManifest(
	bb: Blackboard,
	text: string,
	options: {
		checkpoint: string;
		workspot: string;
		report: string;
		revalidate?: boolean;
	},
): Promise<ReceivedArtifactReview> {
	const base: ReceivedArtifactReview = {
		status: "unknown",
		reasons: [],
		refs: [options.checkpoint],
		changedFiles: [],
		workspot: options.workspot,
		localCheckpointId: options.checkpoint,
		limitations:
			"Imported sender claims do not authorize effects or authenticate provenance",
	};
	const decoded = decodeArtifactManifest(text);
	if (decoded.status !== "valid") return { ...base, reasons: [decoded.reason] };
	const manifest = decoded.manifest;
	const all: Checkpoint[] = Object.values(
		await bb.checkpoints.scanAll(),
	).flat();
	const policy = all.find((cp) => cp.id === options.checkpoint);
	if (!policy)
		return { ...base, status: "rejected", reasons: ["local-policy-missing"] };
	const cwd = await workspotWorktreePath(bb, options.workspot);
	if (!cwd) return { ...base, reasons: ["local-workspot-unreadable"] };
	const review = await checkReceivedArtifact(
		manifest,
		policy,
		cwd,
		options.report,
		options.workspot,
	);
	if (
		!options.revalidate ||
		review.status === "rejected" ||
		review.status === "unknown"
	)
		return review;
	const cp = await revalidateArtifact(bb, policy.id, {
		workspot: options.workspot,
		handoff: manifest,
		expectedCwd: cwd,
		expectedPolicy: {
			artifact: policy.artifact,
			verification: policy.verification,
		},
	});
	const local = (await listArtifactReviews(bb)).find(
		(row) => row.rootId === (cp.revalidates ?? cp.id),
	);
	const after = await checkReceivedArtifact(
		manifest,
		policy,
		cwd,
		options.report,
		options.workspot,
	);
	return {
		...after,
		status:
			local?.status === "current"
				? "locally-checked"
				: cp.verificationResult?.status === "failed" ||
						cp.verificationResult?.status === "timeout"
					? "failed"
					: "unknown",
		checkedCheckpointId: cp.id,
		localCheck: {
			result: cp.verificationResult?.status ?? "unknown",
			exitCode: cp.verificationResult?.exitCode ?? null,
			objectHash: cp.verificationResult?.object?.manifestHash ?? null,
			reportHash: cp.verificationResult?.evidence?.reportHash ?? null,
		},
		refs: [...new Set([...after.refs, cp.id])],
		reasons: [
			...after.reasons,
			local?.status === "current"
				? "local-policy-actually-checked"
				: "local-check-not-current",
		],
		limitations:
			"New local check binds this receiver; original sender manifest remains separate and its effects are never imported",
	};
}
