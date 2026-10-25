import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { hashText } from "../hash";
import type { ArtifactManifest } from "../types/artifact-manifest";
import type { Checkpoint } from "../types/checkpoint";
import {
	collectVerificationEvidence,
	evidenceFilePath,
} from "../verifier/evidence-report";
import { fixedNodeRunner } from "../verifier/fixed-node";
import { FIXED_RUNNER } from "../verifier/fixed-runner";
import { declaredFixedFiles } from "../verifier/isolated-files";
import { assessArtifactManifest, stableManifestJson } from "./manifest-codec";
import { targetSnapshot } from "./target-snapshot";

export interface ReceivedArtifactReview {
	status:
		| "matched"
		| "revalidation-required"
		| "rejected"
		| "unknown"
		| "locally-checked"
		| "failed";
	reasons: string[];
	refs: string[];
	changedFiles: string[];
	workspot: string;
	localCheckpointId: string;
	checkedCheckpointId?: string;
	localCheck?: {
		result: string;
		exitCode: number | null;
		objectHash: string | null;
		reportHash: string | null;
	};
	limitations: string;
}

/** Explicit workspot maps the manifest's relative root; a local policy supplies every executable decision. */
export async function checkReceivedArtifact(
	manifest: ArtifactManifest,
	policy: Checkpoint,
	cwd: string,
	reportPath: string,
	workspot: string,
): Promise<ReceivedArtifactReview> {
	const review: ReceivedArtifactReview = {
		status: "unknown",
		reasons: [],
		refs: [manifest.digest, policy.id],
		changedFiles: [],
		workspot,
		localCheckpointId: policy.id,
		limitations:
			"Unsigned sender provenance is retained as a claim; matching files/report is not a local execution or effect authorization",
	};
	const assessment = assessArtifactManifest(manifest);
	if (assessment.status !== "bound-scope-evidence")
		return { ...review, status: "rejected", reasons: assessment.issues };
	const artifact = policy.artifact;
	const verification = policy.verification;
	const spec = verification?.evidence;
	if (
		!artifact ||
		!spec?.fixedFiles ||
		!verification ||
		verification.command ||
		verification.strategy === "human-review"
	)
		return {
			...review,
			status: "rejected",
			reasons: ["local-policy-not-fixed-files"],
		};
	const normalize = (path: string) =>
		path.replace(/\\/g, "/").replace(/^\.\//, "");
	if (
		normalize(artifact.path) !== manifest.artifact.path ||
		JSON.stringify(artifact.inputs.map(normalize).sort()) !==
			JSON.stringify(manifest.inputs.map((file) => file.path).sort()) ||
		JSON.stringify(declaredFixedFiles(verification, artifact)) !==
			JSON.stringify(
				manifest.verification.object!.files.map((file) => file.path),
			) ||
		normalize(spec.fixedFiles.script) !== manifest.scope.script ||
		normalize(spec.report.path) !== manifest.scope.reportPath ||
		JSON.stringify(spec.inputs.map(normalize).sort()) !==
			JSON.stringify([...manifest.scope.configPaths].sort()) ||
		JSON.stringify([...spec.report.expectedTests].sort()) !==
			JSON.stringify([...manifest.scope.expectedTests].sort()) ||
		artifact.targetRef !== manifest.target.ref
	)
		return {
			...review,
			status: "rejected",
			reasons: ["local-policy-scope-mismatch"],
		};
	try {
		const node = await fixedNodeRunner(cwd);
		if (
			!isDeepStrictEqual(node.runner, manifest.verification.object!.runner) ||
			manifest.verification.object!.bootstrapHash !== hashText(FIXED_RUNNER)
		)
			review.reasons.push("local-runner-differs");
		let total = 0;
		for (const file of manifest.verification.object!.files) {
			const path = await evidenceFilePath(cwd, file.path);
			const before = await stat(path);
			total += before.size;
			if (!before.isFile() || total > 20_000_000)
				return { ...review, reasons: ["local-file-budget"] };
			const content = await readFile(path);
			const after = await stat(path);
			if (
				before.size !== content.length ||
				before.mtimeMs !== after.mtimeMs ||
				before.ctimeMs !== after.ctimeMs
			)
				return { ...review, reasons: ["local-files-changed-during-read"] };
			if (
				file.bytes !== content.length ||
				file.hash !== createHash("sha256").update(content).digest("hex")
			) {
				review.changedFiles.push(file.path);
			}
		}
		const report = await collectVerificationEvidence(
			cwd,
			{ ...spec, report: { ...spec.report, path: reportPath } },
			null,
		);
		if (report.status === "unknown")
			return { ...review, reasons: ["incoming-report-unreadable"] };
		const sender = manifest.verification;
		if (
			report.status !== "satisfied" ||
			report.reportHash !== sender.reportHash ||
			!isDeepStrictEqual(report.actualTests, sender.actualTests) ||
			!isDeepStrictEqual(report.counts, sender.counts)
		)
			review.reasons.push("incoming-report-mismatch");
		const target = await targetSnapshot(cwd, policy);
		if (
			!target ||
			target.status === "unknown" ||
			!target.commit ||
			!target.tree
		)
			return { ...review, reasons: ["local-target-unreadable"] };
		if (
			target.commit !== manifest.target.currentCommit ||
			target.tree !== manifest.target.currentTree ||
			target.ref !== manifest.target.currentRef ||
			stableManifestJson(
				Object.entries(target.blobs ?? {})
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([path, hash]) => ({ path, hash })),
			) !== stableManifestJson(manifest.target.currentBlobs)
		)
			review.reasons.push("local-target-advanced-or-different");
		if (review.changedFiles.length) review.reasons.push("local-files-differ");
		review.status = review.reasons.length ? "revalidation-required" : "matched";
		return review;
	} catch {
		return { ...review, reasons: ["local-objects-or-runner-cannot-measure"] };
	}
}
