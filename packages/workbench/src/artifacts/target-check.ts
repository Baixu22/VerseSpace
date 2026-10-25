import type { ArtifactSnapshot } from "../types/artifact-evidence";
import type { Checkpoint } from "../types/checkpoint";

/** A recorded candidate check is a distinct fact from equal target input hashes. */
export function targetCheckIssue(cp: Checkpoint): string | null {
	const check = cp.artifactTargetCheck;
	if (!check)
		return cp.artifactTargetCandidate ? "显式目标候选缺少真实检查记录" : null;
	const object = cp.verificationResult?.object;
	const target = cp.artifactBinding?.target;
	if (
		!cp.artifactTargetCandidate ||
		!object ||
		!target ||
		cp.verificationResult?.status !== "passed" ||
		cp.verificationResult.evidence?.status !== "satisfied" ||
		cp.verificationBinding?.context?.authority !== "command" ||
		check.workspot !== cp.workspot ||
		check.workspot !== cp.artifactTargetCandidate.workspot ||
		check.ref !== cp.artifactTargetCandidate.ref ||
		check.ref !== target.ref ||
		check.baseCommit !== target.commit ||
		check.baseTree !== target.tree ||
		check.candidateHead !== check.baseCommit ||
		check.candidateHead !== cp.artifactBinding?.head ||
		check.candidateCwd !== object.sourceCwd ||
		check.candidateCwd !== cp.artifactBinding?.cwd ||
		check.objectManifestHash !== object.manifestHash
	)
		return "目标候选检查的执行对象、工位或基线身份不一致";
	return null;
}

export function targetRangeUnchanged(
	before: ArtifactSnapshot["target"],
	after: ArtifactSnapshot["target"],
): boolean {
	if (
		before?.scope !== "declared-files-v1" ||
		after?.scope !== "declared-files-v1" ||
		!before.blobs ||
		!after.blobs
	)
		return false;
	const paths = Object.keys(before.blobs);
	return (
		paths.length > 0 &&
		paths.length === Object.keys(after.blobs).length &&
		paths.every(
			(path) =>
				Object.hasOwn(after.blobs!, path) &&
				before.blobs![path] === after.blobs![path],
		)
	);
}
