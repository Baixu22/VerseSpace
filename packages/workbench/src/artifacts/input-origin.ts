import { resolve } from "node:path";
import type { Blackboard } from "../blackboard";
import { claimObservation } from "../blackboard/claim-version";
import { sameInputPath } from "../blackboard/input-content";
import { inputObservationSchema } from "../blackboard/session-types";
import { workspotWorktreePath } from "../runtime/verification-binding";
import type {
	ArtifactInputOrigin,
	ArtifactInputSelection,
} from "../types/artifact-evidence";
import type { Checkpoint } from "../types/checkpoint";

/** Resolve exact caller-selected history, including reads already superseded in the live view. */
export async function selectArtifactInputs(
	bb: Blackboard,
	cp: Checkpoint,
): Promise<ArtifactInputOrigin | undefined> {
	const artifact = cp.artifact;
	if (!artifact?.inputRecords) return undefined;
	const reads: ArtifactInputOrigin["reads"] = [];
	const reasons: string[] = [];
	const missing = new Set(artifact.inputs);
	const cwd = await workspotWorktreePath(bb, cp.workspot);
	if (!cwd)
		return {
			schemaVersion: 1,
			source: "declared",
			status: "unknown",
			capturedAt: new Date().toISOString(),
			workspot: cp.workspot,
			reads,
			missingInputs: [...missing],
			reason: "所选来源工位不可解析",
		};
	const seen = new Set<string>();
	for (const selection of artifact.inputRecords) {
		if (!artifact.inputs.includes(selection.path)) {
			reasons.push(`${selection.path} 不在显式输入清单`);
			continue;
		}
		const key = JSON.stringify([
			selection.path,
			selection.writerId,
			selection.footprintSeq,
			selection.selector?.kind,
			selection.selector?.kind === "lines" ? selection.selector.start : null,
			selection.selector?.kind === "lines" ? selection.selector.end : null,
		]);
		if (seen.has(key)) {
			reasons.push(`${selection.path} 重复选择同一读取`);
			continue;
		}
		seen.add(key);
		const writer = await bb.sessions.get(selection.writerId);
		if (writer?.id !== selection.writerId) {
			reasons.push(`${selection.path} 的写者身份不可核对`);
			continue;
		}
		const line = (await bb.sessions.footprint(selection.writerId)).find(
			(line) => line.seq === selection.footprintSeq,
		);
		const candidates = line?.used.filter(
			(read) =>
				sameInputPath(
					bb.projectRoot,
					read.path,
					resolve(cwd, selection.path),
				) && selectorMatches(selection, read.span),
		);
		if (candidates?.length !== 1 || !line) {
			reasons.push(`${selection.path} 的写者/序号/范围不存在或含糊`);
			continue;
		}
		const read = candidates[0]!;
		const evidence = claimObservation(read);
		const observation = inputObservationSchema.safeParse(read.observation);
		const selector =
			read.span &&
			(read.span.start !== 1 || read.span.end !== Number.MAX_SAFE_INTEGER)
				? { kind: "lines" as const, start: read.span.start, end: read.span.end }
				: { kind: "file" as const };
		reads.push({
			path: selection.path,
			recordPath: read.path,
			writerId: selection.writerId,
			actingAgent: line.agent,
			footprintSeq: line.seq,
			eventId: line.eventId,
			eventSeq: line.eventSeq,
			selector,
			version: read.version ?? null,
			strength: evidence.source,
			binding: evidence.binding,
			...(read.size !== undefined ? { size: read.size } : {}),
			...(evidence.source === "tool-observed" || evidence.source === "declared"
				? { contentHash: evidence.contentHash }
				: {}),
			...(observation.success ? { observation: observation.data } : {}),
		});
		missing.delete(selection.path);
	}
	return {
		schemaVersion: 1,
		source: "declared",
		status: reasons.length || missing.size ? "unknown" : "selected",
		capturedAt: new Date().toISOString(),
		workspot: cp.workspot,
		cwd,
		reads,
		missingInputs: [...missing],
		reason: reasons.length
			? reasons.join("；")
			: missing.size
				? "部分声明输入未选择历史记录"
				: "调用者显式选择历史读取；不证明因果或依赖完整性",
	};
}

function selectorMatches(
	selection: ArtifactInputSelection,
	span?: { start: number; end: number },
): boolean {
	if (!selection.selector) return true;
	if (selection.selector.kind === "file")
		return !span || (span.start === 1 && span.end === Number.MAX_SAFE_INTEGER);
	return (
		span?.start === selection.selector.start &&
		span.end === selection.selector.end
	);
}
