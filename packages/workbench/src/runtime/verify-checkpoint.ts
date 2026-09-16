import { isAbsolute, join } from "node:path";
import type { Blackboard } from "../blackboard";
import type { Checkpoint } from "../types/checkpoint";
import { runVerification } from "../verifier";
import { event } from "./events";
import type { RunOnceResult } from "./types";

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
	const pending: Checkpoint = { ...checkpoint, lifecycle: "pending" };
	await bb.checkpoints.save(pending, "staging");

	const result = await runVerification(
		checkpoint.verification,
		await resolveWorktree(bb, checkpoint),
	);
	const withResult: Checkpoint = {
		...pending,
		verificationResult: {
			status: result.status,
			output: result.status === "failed" ? result.output : undefined,
			at: new Date().toISOString(),
		},
	};

	if (result.status === "passed") {
		await bb.checkpoints.save(
			{ ...withResult, lifecycle: "verified" },
			"staging",
		);
		await bb.checkpoints.move(cpId, "staging", "verified");
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
