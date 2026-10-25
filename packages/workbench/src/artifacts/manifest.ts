import { isDeepStrictEqual } from "node:util";
import type { Blackboard } from "../blackboard";
import { claimObservation } from "../blackboard/claim-version";
import { hashText } from "../hash";
import { portableObjectSchema } from "../types/artifact-manifest";
import type { Checkpoint } from "../types/checkpoint";
import { selectArtifactInputs } from "./input-origin";
import { sealArtifactManifest } from "./manifest-codec";
import { listArtifactReviews } from "./status";

const pathName = (path: string) =>
	path.replace(/\\/g, "/").replace(/^\.\//, "");

/** Select fields deliberately: no cwd, raw tool payload, command, config value or effects. */
export async function exportArtifactManifest(bb: Blackboard, id: string) {
	const all: Checkpoint[] = Object.values(
		await bb.checkpoints.scanAll(),
	).flat();
	const requested = all.find((cp) => cp.id === id);
	if (!requested?.artifact) throw new Error("checkpoint 没有声明产物");
	const root = all.find(
		(cp) => cp.id === (requested.revalidates ?? requested.id),
	)!;
	const review = (await listArtifactReviews(bb)).find(
		(row) => row.rootId === root.id,
	)!;
	const cp = all.find((entry) => entry.id === review.checkpointId)!;
	const artifact = cp.artifact!;
	const spec = cp.verification?.evidence;
	if (!spec) throw new Error("导出需要已声明的检查范围");
	const check = cp.verificationResult;
	const context = cp.verificationBinding?.context;
	const source = root.artifactInputOrigin;
	const selected = await selectArtifactInputs(bb, root);
	const identity = (value: typeof source) =>
		value ? { ...value, capturedAt: undefined } : undefined;
	const locallyMatched =
		!!source && isDeepStrictEqual(identity(source), identity(selected));
	const originReads = (source?.reads ?? []).map((read) => {
		const observed = claimObservation({
			path: read.recordPath,
			version: read.version,
			size: read.size,
			observation: read.observation,
			span: read.selector.kind === "lines" ? read.selector : undefined,
		});
		return {
			path: pathName(read.path),
			writerHash: hashText(read.writerId),
			footprintSeq: read.footprintSeq,
			eventHash: read.eventId ? hashText(read.eventId) : null,
			eventSeq: read.eventSeq ?? null,
			selector: read.selector,
			version: read.version ?? null,
			source: observed.source,
			binding: observed.binding,
			contentHash: "contentHash" in observed ? observed.contentHash : null,
			returnedHash: "returnedHash" in observed ? observed.returnedHash : null,
		};
	});
	const target = cp.artifactBinding?.target;
	const now = review.targetNow;
	// The portable object excludes both source and executed absolute directories.
	const object = check?.object
		? portableObjectSchema.parse(
				Object.fromEntries(
					Object.entries(check.object).filter(
						([key]) =>
							key !== "sourceCwd" &&
							key !== "executedCwd" &&
							key !== "reportFile",
					),
				),
			)
		: null;
	return sealArtifactManifest({
		schemaVersion: 1,
		kind: "workbench-artifact-evidence",
		artifact: {
			path: pathName(artifact.path),
			hash: cp.artifactBinding?.files[artifact.path] ?? null,
		},
		inputs: artifact.inputs.map((path) => ({
			path: pathName(path),
			checkedHash: cp.artifactBinding?.files[path] ?? null,
		})),
		origin: {
			strength: review.facts?.origin.strength ?? "unknown",
			locallyMatched,
			workspotHash: source ? hashText(source.workspot) : null,
			reads: originReads,
		},
		scope: {
			mode: spec.fixedFiles?.mode ?? "workspace-command-v1",
			complete: !!spec.fixedFiles?.complete,
			script: spec.fixedFiles ? pathName(spec.fixedFiles.script) : null,
			configPaths: spec.inputs.map(pathName),
			reportPath: pathName(spec.report.path),
			expectedTests: spec.report.expectedTests,
		},
		verification: {
			result: check?.status ?? "unknown",
			current: review.status,
			scopeStatus: check?.evidence?.status ?? "unknown",
			authority: context?.authority ?? "unknown",
			exitCode: check?.exitCode ?? null,
			reportHash: check?.evidence?.reportHash ?? null,
			actualTests: check?.evidence?.actualTests ?? [],
			counts: check?.evidence?.counts ?? {
				total: 0,
				passed: 0,
				failed: 0,
				skipped: 0,
			},
			object,
		},
		context: {
			rootHash: hashText(root.id),
			checkpointHash: hashText(cp.id),
			workspotHash: hashText(cp.workspot),
			head: cp.artifactBinding?.head ?? null,
			platform: context?.evidence?.runner.platform ?? "unknown",
			arch: context?.evidence?.runner.arch ?? "unknown",
			timeoutSeconds: context?.timeoutSeconds ?? null,
		},
		target: {
			status: review.targetStatus,
			ref: artifact.targetRef ?? null,
			baseRef: target?.ref ?? null,
			currentRef: now?.ref ?? null,
			baseCommit: target?.commit ?? null,
			baseTree: target?.tree ?? null,
			currentCommit: now?.commit ?? null,
			currentTree: now?.tree ?? null,
			change: review.targetChange ?? "unknown",
			blobs: Object.entries(target?.blobs ?? {})
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([path, hash]) => ({ path, hash })),
			currentBlobs: Object.entries(now?.blobs ?? {})
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([path, hash]) => ({ path, hash })),
			candidate: cp.artifactTargetCheck
				? {
						workspotHash: hashText(cp.artifactTargetCheck.workspot),
						head: cp.artifactTargetCheck.candidateHead,
						objectHash: cp.artifactTargetCheck.objectManifestHash,
					}
				: null,
		},
		limitations:
			"Unsigned declared-scope evidence; recipient must verify objects and run its own local policy",
	});
}
