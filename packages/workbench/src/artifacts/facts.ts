import type { Blackboard } from "../blackboard";
import { claimObservation } from "../blackboard/claim-version";
import { artifactInputOriginSchema } from "../types/artifact-evidence";
import type { Checkpoint } from "../types/checkpoint";
import { captureArtifactSnapshot } from "./snapshot";

export interface ArtifactFacts {
	/** Historical origin strength, never upgraded by a later verification. */
	origin: {
		strength: "tool-observed" | "fs-sample" | "declared" | "unknown";
		reason: string;
	};
	/** Compare explicit input bytes with the latest check, not with the original reads. */
	inputs: {
		status: "matched" | "different" | "unknown";
		versions: Record<string, string>;
		changed: string[];
	};
	verification: {
		checkpointId: string;
		result: string | null;
		scope: string;
		authority: "command" | "human" | "unknown";
		at: string | null;
	};
}

function originFact(root: Checkpoint): ArtifactFacts["origin"] {
	const parsed = artifactInputOriginSchema.safeParse(root.artifactInputOrigin);
	const origin = parsed.success ? parsed.data : undefined;
	if (!root.artifact?.inputRecords)
		return {
			strength: "declared",
			reason: "仅有声明输入与创建时采样，没有历史工具内容来源",
		};
	if (
		origin?.status !== "selected" ||
		!origin.reads.length ||
		origin.missingInputs.length ||
		!root.artifact.inputs.every((path) =>
			origin.reads.some((read) => read.path === path),
		)
	)
		return { strength: "unknown", reason: origin?.reason ?? "所选来源未记录" };
	const evidence = origin.reads.map((read) =>
		claimObservation({
			path: read.recordPath,
			version: read.version,
			size: read.size,
			observation: read.observation,
			span: read.selector.kind === "lines" ? read.selector : undefined,
		}),
	);
	const sources = new Set(evidence.map((read) => read.source));
	return sources.size === 1 && !sources.has("unknown")
		? { strength: evidence[0]!.source, reason: origin.reason }
		: {
				strength: "unknown",
				reason: "所选来源包含弱、混合或未知凭据，未升级为工具观察",
			};
}

/** Four fact families remain independently inspectable; reads never rerun verification. */
export async function artifactFacts(
	bb: Blackboard,
	root: Checkpoint,
	latest: Checkpoint,
): Promise<ArtifactFacts> {
	const snapshot = await captureArtifactSnapshot(bb, latest);
	const versions: Record<string, string> = {};
	const changed: string[] = [];
	let unknown = !snapshot || !latest.artifactBinding;
	for (const path of latest.artifact?.inputs ?? []) {
		const current = snapshot?.files[path];
		const verified = latest.artifactBinding?.files[path];
		if (current) versions[path] = current;
		if (!current || !verified) unknown = true;
		else if (current !== verified) changed.push(path);
	}
	return {
		origin: originFact(root),
		inputs: {
			status: unknown ? "unknown" : changed.length ? "different" : "matched",
			versions,
			changed,
		},
		verification: {
			checkpointId: latest.id,
			result: latest.verificationResult?.status ?? null,
			scope: latest.verificationResult?.evidence?.status ?? "unknown",
			authority: latest.verificationBinding?.context?.authority ?? "unknown",
			at: latest.verificationResult?.at ?? null,
		},
	};
}
