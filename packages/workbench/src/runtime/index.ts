import { isAbsolute, join } from "node:path";
import { evaluate } from "../automaton/evaluator";
import type { Blackboard } from "../blackboard";
import { generateContext } from "../contextgen/generate";
import { type DispatchResult, runScheduler } from "../scheduler/dispatch";
import type { Checkpoint } from "../types/checkpoint";
import type { WorldSnapshot } from "../types/snapshot";
import type { Transition } from "../types/transitions";
import { runVerification, type VerifyResult } from "../verifier";

export interface RuntimeNotification {
	message: string;
	severity: "info" | "warning" | "error";
}

export interface RunOnceResult {
	/** Transitions the automaton computed from the entry snapshot. */
	transitions: Transition[];
	/** How many transitions were actually applied (stale ones are skipped). */
	applied: number;
	notifications: RuntimeNotification[];
	verifications: Array<{ cpId: string; result: VerifyResult }>;
	/** Interfaces whose registry entry was re-anchored to fresh content. */
	reanchored: string[];
	/** Dispatches executed by the auto scheduler (empty for manual policy). */
	dispatches: DispatchResult[];
}

function event(bb: Blackboard, type: string, payload: unknown): Promise<void> {
	return bb.events.append({
		timestamp: new Date().toISOString(),
		source: "runtime",
		type,
		payload,
	});
}

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
async function verifyCheckpoint(
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

async function applyTransition(
	bb: Blackboard,
	transition: Transition,
	notifications: RuntimeNotification[],
	verifications: RunOnceResult["verifications"],
): Promise<boolean> {
	switch (transition.type) {
		case "goal_status": {
			const goal = await bb.goals.get(transition.goalId);
			if (!goal || goal.status !== transition.from) {
				return false;
			}
			if (transition.to === "done") {
				// Anchor the completed goal to every registered interface version
				// at completion time; later version bumps mark it stale (the
				// mark_stale rule reads these anchors).
				const interfaces = Object.fromEntries(
					(await bb.interfaces.list()).map((entry) => [
						entry.key,
						entry.version,
					]),
				);
				await bb.goals.update(transition.goalId, {
					status: "done",
					verifiedAgainst: {
						interfaces,
						decisions: goal.verifiedAgainst.decisions,
					},
				});
			} else {
				await bb.goals.update(transition.goalId, { status: transition.to });
			}
			await event(bb, "goal_status", transition);
			return true;
		}
		case "mark_stale": {
			const goal = await bb.goals.get(transition.goalId);
			if (goal?.status !== "done") {
				return false;
			}
			await bb.goals.update(transition.goalId, {
				status: "stale_done",
				staleReason: transition.reason,
			});
			await event(bb, "mark_stale", transition);
			return true;
		}
		case "enqueue_goal": {
			await bb.state.queue.enqueue(transition.goalId);
			await event(bb, "enqueue_goal", transition);
			return true;
		}
		case "dequeue_goal": {
			await bb.state.queue.dequeue(transition.goalId);
			await event(bb, "dequeue_goal", transition);
			return true;
		}
		case "checkpoint_lifecycle": {
			const verified = (await bb.checkpoints.scanZone("verified")).find(
				(cp) => cp.id === transition.cpId,
			);
			if (!verified || verified.lifecycle !== transition.from) {
				return false;
			}
			// blackboardEffects bookkeeping rides on the applied event; registry
			// content anchoring is handled by the drift re-anchor sweep below.
			await bb.checkpoints.save(
				{ ...verified, lifecycle: "applied" },
				"verified",
			);
			await event(bb, "checkpoint_applied", {
				cpId: transition.cpId,
				effects: verified.blackboardEffects,
			});
			return true;
		}
		case "workspot_status": {
			const workspot = await bb.state.workspots.get(transition.wsId);
			if (!workspot || workspot.status !== transition.from) {
				return false;
			}
			await bb.state.workspots.save({
				...workspot,
				status: transition.to,
				// releasing a workspot clears its borrowed assignment
				currentTask:
					transition.to === "idle" ? undefined : workspot.currentTask,
			});
			await event(bb, "workspot_status", transition);
			return true;
		}
		case "refresh_context": {
			const result = await generateContext(bb, transition.wsId);
			await event(bb, "refresh_context", {
				wsId: transition.wsId,
				ok: result.ok,
				reason: result.reason,
			});
			return true;
		}
		case "request_verification":
			return verifyCheckpoint(bb, transition.cpId, verifications);
		case "notify_human": {
			notifications.push({
				message: transition.message,
				severity: transition.severity,
			});
			await event(bb, "notify_human", transition);
			return true;
		}
	}
}

/**
 * Runtime (skeleton section 四): the module composer. One run =
 * snapshot → automaton → apply each transition → re-anchor drifted interfaces.
 *
 * - idempotent: a consistent world produces zero transitions and zero writes;
 * - re-entrant: every transition is judged against the ENTRY snapshot only;
 *   effects it triggers are picked up by the next run, never recursively;
 * - observable: every applied transition and verification lands in the event
 *   log.
 */
export async function runOnce(bb: Blackboard): Promise<RunOnceResult> {
	const snapshot: WorldSnapshot = await bb.snapshot();
	const transitions = evaluate(snapshot);

	const notifications: RuntimeNotification[] = [];
	const verifications: RunOnceResult["verifications"] = [];
	let applied = 0;
	for (const transition of transitions) {
		if (await applyTransition(bb, transition, notifications, verifications)) {
			applied += 1;
		}
	}

	// Skeleton step 5: anchor registry entries to fresh interface content.
	// The version bump makes the NEXT run's automaton mark anchored done-goals
	// stale — drift handling never retroactively rewrites a done goal.
	const reanchored: string[] = [];
	for (const entry of await bb.interfaces.list()) {
		const report = await bb.interfaces.checkDrift(entry.key);
		if (report.drifted && !report.missing && report.currentHash !== null) {
			await bb.interfaces.updateVersion(entry.key, report.currentHash);
			reanchored.push(entry.key);
			await event(bb, "interface_reanchored", {
				key: entry.key,
				version: entry.version + 1,
			});
		}
	}

	// Skeleton step 4: scheduler decisions. manual policy never dispatches;
	// semi-auto only surfaces suggestions as notifications.
	const config = await bb.config.load();
	const dispatches: DispatchResult[] = [];
	if (config.scheduler.policy !== "manual") {
		dispatches.push(
			...(await runScheduler(
				bb,
				config.scheduler.policy,
				config.scheduler.autoConstraints?.maxConcurrentWorkspots ?? 2,
				async (message, severity) => {
					notifications.push({ message, severity });
					await event(bb, "notify_human", { message, severity });
				},
			)),
		);
	}

	return {
		transitions,
		applied,
		notifications,
		verifications,
		reanchored,
		dispatches,
	};
}
