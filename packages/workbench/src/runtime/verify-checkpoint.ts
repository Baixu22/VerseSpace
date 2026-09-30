import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	artifactSnapshotDifference,
	captureArtifactSnapshot,
} from "../artifacts/snapshot";
import type { Blackboard } from "../blackboard";
import { parseDurationSeconds } from "../duration";
import type { Checkpoint } from "../types/checkpoint";
import { runVerification } from "../verifier";
import { event } from "./events";
import type { RunOnceResult } from "./types";
import {
	captureBindingForWorktree,
	compareVerificationBindings,
} from "./verification-binding";
import { captureVerificationContext } from "./verification-context";

function worktreePath(bb: Blackboard, workspotId: string): string {
	const fallback = join(bb.projectRoot, "worktrees", workspotId);
	// resolved synchronously by the caller via the workspot record; this helper
	// covers the "workspot vanished" case with the conventional location
	return fallback;
}

async function resolveWorktree(
	bb: Blackboard,
	checkpoint: Checkpoint,
): Promise<string> {
	const workspot = await bb.state.workspots.get(checkpoint.workspot);
	if (!workspot) {
		return worktreePath(bb, checkpoint.workspot);
	}
	return isAbsolute(workspot.worktreePath)
		? workspot.worktreePath
		: join(bb.projectRoot, workspot.worktreePath);
}

/**
 * Execute one `request_verification` transition: set the checkpoint pending,
 * run the Verifier inside the workspot worktree, archive the outcome, and
 * relocate the checkpoint (verified zone / failed zone / awaiting_review).
 */
export async function verifyCheckpoint(
	bb: Blackboard,
	cpId: string,
	verifications: RunOnceResult["verifications"],
): Promise<boolean> {
	const staging = await bb.checkpoints.scanZone("staging");
	const checkpoint = staging.find((cp) => cp.id === cpId);
	if (!checkpoint) {
		return false;
	}
	const artifactBefore = await captureArtifactSnapshot(bb, checkpoint);
	const pending: Checkpoint = {
		...checkpoint,
		lifecycle: "pending",
		verificationBinding: undefined,
		verificationBindingIssue: undefined,
		artifactOrigin: checkpoint.artifactOrigin ?? artifactBefore,
		artifactBinding: undefined,
	};
	await bb.checkpoints.save(pending, "staging");

	// P0-2: `thresholds.checkpointTimeout` is the default when the checkpoint
	// does not declare its own timeout. Before this it was read by nothing.
	const config = await bb.config.load();
	const worktree = await resolveWorktree(bb, checkpoint);
	const defaultTimeout =
		parseDurationSeconds(config.thresholds.checkpointTimeout) ?? undefined;
	const context = await captureVerificationContext(
		checkpoint.verification,
		worktree,
		defaultTimeout,
		"command",
	);
	const reportPath = checkpoint.verification?.evidence?.report.path;
	const before = await captureBindingForWorktree(bb, worktree, reportPath);
	const result = await runVerification(
		checkpoint.verification,
		worktree,
		defaultTimeout,
	);
	const withResult: Checkpoint = {
		...pending,
		verificationResult: {
			status: result.status,
			output: result.status === "failed" ? result.output : undefined,
			at: new Date().toISOString(),
			exitCode: result.exitCode,
			evidence: result.evidence,
		},
	};

	if (result.status === "passed") {
		// ponytail: endpoint snapshots do not detect ABA or lock external inputs;
		// verification in an immutable copy is needed for that stronger guarantee.
		const binding = await captureBindingForWorktree(bb, worktree, reportPath);
		const afterContext = await captureVerificationContext(
			checkpoint.verification,
			worktree,
			defaultTimeout,
			"command",
		);
		const comparison = before
			? compareVerificationBindings(before, binding)
			: undefined;
		const artifactAfter = await captureArtifactSnapshot(bb, checkpoint);
		const artifactIssue = checkpoint.artifact
			? !artifactBefore
				? "产物来源或声明输入未知"
				: artifactSnapshotDifference(artifactBefore, artifactAfter)
			: null;
		const issue = artifactIssue
			? artifactIssue
			: result.evidence && result.evidence.status !== "satisfied"
				? `验证范围未满足：${result.evidence.reason}`
				: !before || !binding || !context || !afterContext
					? "验证代码状态未知：无法完整采集检查前后的工作区，不能确认当前有效"
					: !isDeepStrictEqual(context, afterContext)
						? "验证期间执行条件或配置输入已变化，需要重新验证"
						: comparison?.status === "invalidated"
							? `验证期间代码状态变化：${comparison.reason}；需要重新验证`
							: undefined;
		await bb.checkpoints.save(
			{
				...withResult,
				lifecycle: issue ? "awaiting_review" : "verified",
				verificationBinding:
					issue || !binding ? undefined : { ...binding, context },
				verificationBindingIssue: issue,
				artifactBinding: issue ? undefined : artifactAfter,
			},
			"staging",
		);
		if (issue) {
			await event(bb, "verification_awaiting_review", { cpId, reason: issue });
		} else {
			await bb.checkpoints.move(cpId, "staging", "verified");
		}
	} else if (result.status === "failed" || result.status === "timeout") {
		await bb.checkpoints.save(
			{ ...withResult, lifecycle: "failed" },
			"staging",
		);
		await bb.checkpoints.move(cpId, "staging", "failed");
		await event(bb, "verification_failed", { cpId, status: result.status });
	} else if (result.status === "needs_human") {
		await bb.checkpoints.save(
			{ ...withResult, lifecycle: "awaiting_review" },
			"staging",
		);
		await event(bb, "verification_awaiting_review", { cpId });
	} else {
		// skipped: stays draft-pending in staging for doctor to flag
		await bb.checkpoints.save(withResult, "staging");
		await event(bb, "verification_skipped", { cpId });
	}
	verifications.push({ cpId, result });
	await event(bb, "request_verification", { cpId });
	return true;
}
