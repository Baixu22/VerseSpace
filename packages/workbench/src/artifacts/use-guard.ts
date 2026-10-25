import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Blackboard } from "../blackboard";
import { claimObservation } from "../blackboard/claim-version";
import { hashText } from "../hash";
import {
	verificationStalenessReason,
	workspotWorktreePath,
} from "../runtime/verification-binding";
import type { Checkpoint } from "../types/checkpoint";
import { collectVerificationEvidence } from "../verifier/evidence-report";
import { artifactFacts } from "./facts";
import { selectArtifactInputs } from "./input-origin";

export type ArtifactUseDecision = {
	ok: boolean;
	rootId: string;
	evidenceId: string;
	refs: string[];
	reason: string;
	receipt?: NonNullable<Checkpoint["artifactConsumption"]>;
};

/** Called under the runtime run lock immediately before effects. No tool execution or edits. */
export async function checkArtifactUse(
	bb: Blackboard,
	root: Checkpoint,
	requestedEvidenceId?: string,
): Promise<ArtifactUseDecision> {
	const all = Object.values(await bb.checkpoints.scanAll()).flat();
	const latest = [root, ...all.filter((cp) => cp.revalidates === root.id)].sort(
		(a, b) =>
			b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id),
	)[0]!;
	const refs = [
		...new Set([
			root.id,
			latest.id,
			...(root.artifactInputOrigin?.reads.flatMap((read) =>
				read.eventId ? [`footprint:${read.eventId}`] : [],
			) ?? []),
		]),
	];
	const decision = (reason: string): ArtifactUseDecision => ({
		ok: false,
		rootId: root.id,
		evidenceId: latest.id,
		refs,
		reason,
	});
	if (!root.artifact || root.revalidates)
		return decision("需要原始声明产物 checkpoint，重验记录不携带验收效果");
	if (
		root.lifecycle === "applied" ||
		root.artifactConsumption ||
		(await bb.events.query({ type: "checkpoint_applied" })).some(
			(event) => (event.payload as { cpId?: string })?.cpId === root.id,
		)
	)
		return decision("原 checkpoint 已消费，禁止重复应用 effects");
	if (root.lifecycle !== "verified")
		return decision("原 checkpoint 尚未通过验证，不能应用效果");
	if (!root.artifactOrigin)
		return decision("缺少原工位/输入/产物来源采样，不能消费");
	if (requestedEvidenceId && requestedEvidenceId !== latest.id)
		return decision("请求的检查不是最新记录，不能消费旧证据");
	if (
		latest.lifecycle !== "verified" ||
		latest.verificationResult?.status !== "passed" ||
		latest.verificationResult.evidence?.status !== "satisfied" ||
		latest.verificationBinding?.context?.authority !== "command" ||
		!latest.artifactBinding ||
		!latest.verification?.evidence
	)
		return decision("最新检查未完整通过声明范围，或缺少自动检查/产物绑定");
	const declaration = (cp: Checkpoint) =>
		cp.artifact
			? {
					path: cp.artifact.path,
					inputs: cp.artifact.inputs,
					inputRecords: cp.artifact.inputRecords,
					source: cp.artifact.source,
				}
			: null;
	if (
		!isDeepStrictEqual(declaration(root), declaration(latest)) ||
		!isDeepStrictEqual(root.verification, latest.verification) ||
		!isDeepStrictEqual(root.artifactInputOrigin, latest.artifactInputOrigin)
	)
		return decision("最新检查与原声明输入、检查范围或历史来源不一致");
	const facts = await artifactFacts(bb, root, latest);
	if (root.artifact.inputRecords) {
		if (!latest.artifactBinding.declarationHash)
			return decision("检查缺少输入声明 manifest 绑定");
		const selected = await selectArtifactInputs(bb, root);
		const identity = (origin: Checkpoint["artifactInputOrigin"]) =>
			origin ? { ...origin, capturedAt: undefined } : undefined;
		if (
			!isDeepStrictEqual(identity(selected), identity(root.artifactInputOrigin))
		)
			return decision("历史来源凭据与所选原始足迹不一致");
	}
	if (
		root.artifact.inputRecords &&
		(facts.origin.strength !== "tool-observed" ||
			root.artifactInputOrigin?.reads.some(
				(read) =>
					claimObservation({
						path: read.recordPath,
						version: read.version,
						size: read.size,
						observation: read.observation,
						span: read.selector.kind === "lines" ? read.selector : undefined,
					}).binding === "unknown",
			))
	)
		return decision("所选历史输入来源缺失、弱或关联未知，不能签发产物验收可用");
	const stale = await verificationStalenessReason(bb, latest);
	if (stale) return decision(`检查依据已失效：${stale}`);
	if (facts.inputs.status !== "matched")
		return decision("当前声明输入与最新检查不一致或不可读取");
	const cwd = await workspotWorktreePath(bb, latest.workspot);
	if (!cwd) return decision("检查工位不可读取");
	const report = await collectVerificationEvidence(
		latest.verificationResult.object
			? join(bb.paths.checkpoints, "objects")
			: cwd,
		latest.verificationResult.object
			? {
					...latest.verification.evidence,
					report: {
						...latest.verification.evidence.report,
						path: latest.verificationResult.object.reportFile!,
					},
				}
			: latest.verification.evidence,
		null,
	);
	if (
		report.status !== "satisfied" ||
		!report.reportHash ||
		!isDeepStrictEqual(
			{ ...report, reportPath: latest.verificationResult.evidence.reportPath },
			latest.verificationResult.evidence,
		)
	)
		return decision("实际报告与最新记录的范围、用例或 digest 不一致");
	const artifactHash = latest.artifactBinding.files[root.artifact.path];
	if (!artifactHash) return decision("即将消费的产物 digest 缺失");
	const receipt = {
		state: "started" as const,
		evidenceCheckpointId: latest.id,
		at: new Date().toISOString(),
		mode: root.artifact.inputRecords
			? ("recorded-inputs-v1" as const)
			: ("legacy-declared-scope" as const),
		manifestHash: hashText(
			JSON.stringify({
				declaration: declaration(root),
				files: Object.entries(latest.artifactBinding.files).sort(([a], [b]) =>
					a.localeCompare(b),
				),
				origin: root.artifactInputOrigin ?? null,
			}),
		),
		artifactHash,
		reportHash: report.reportHash,
	};
	return {
		ok: true,
		rootId: root.id,
		evidenceId: latest.id,
		refs,
		reason: "最新检查、声明输入与产物 digest 已核对",
		receipt,
	};
}
