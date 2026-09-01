import { isAbsolute, join } from "node:path";
import { evaluate } from "../automaton/evaluator";
import type { Blackboard } from "../blackboard";
import { registryContextStore } from "../blackboard/context-store";
import { generateContext } from "../contextgen/generate";
import { acquireRunLock } from "../fs/lockfile";
import { type DispatchResult, runScheduler } from "../scheduler/dispatch";
import type { Checkpoint } from "../types/checkpoint";
import type { WorldSnapshot } from "../types/snapshot";
import type { Transition } from "../types/transitions";
import { runVerification, type VerifyResult } from "../verifier";
import { captureContextRollback } from "./rollback";

export interface RuntimeNotification {
	message: string;
	severity: "info" | "warning" | "error";
}

/**
 * R3: what the adjudication queue did with this cycle's `notify_human`
 * events. The numbers are the milestone's own acceptance metrics — a cycle
 * that admits everything it emits has no rationalization.
 */
export interface TribunalTally {
	/** Events offered to the queue (i.e. emitters that carried an envelope). */
	submitted: number;
	admitted: number;
	/** Twin events folded into an item the queue was already carrying. */
	folded: number;
	/** Refused by the ISA-18.2 gate or the soft floor. */
	suppressed: number;
}

export function emptyTribunalTally(): TribunalTally {
	return { submitted: 0, admitted: 0, folded: 0, suppressed: 0 };
}

export interface RunOnceResult {
	/** Transitions the automaton computed from the entry snapshot. */
	transitions: Transition[];
	/** How many transitions were actually applied (stale ones are skipped). */
	applied: number;
	notifications: RuntimeNotification[];
	verifications: Array<{ cpId: string; result: VerifyResult }>;
	/** R3: what the adjudication queue did with this cycle's alarms. */
	tribunal: TribunalTally;
	/** Interfaces whose registry entry was re-anchored to fresh content. */
	reanchored: string[];
	/** Dispatches executed by the auto scheduler (empty for manual policy). */
	dispatches: DispatchResult[];
	/** Set when another runOnce is already executing — the cycle was skipped. */
	busy?: boolean;
	/** pid of the holder when busy. */
	lockHolder?: number;
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

/**
 * Offer one emitter's event to the adjudication queue. `notify_human` used to
 * end here — pushed into an array the runtime returned and nobody owned. Now
 * the queue decides whether it is an alarm at all, whether it is a twin of
 * something already queued, and whether a human owes it a decision today.
 *
 * An emitter with no envelope is a plain log line: it keeps its place in
 * `notifications` and the event log, and never reaches a human.
 */
async function offerToTribunal(
	bb: Blackboard,
	transition: Transition & { type: "notify_human" },
	tally: TribunalTally,
	at: string,
): Promise<void> {
	if (!transition.tribunal) {
		return;
	}
	tally.submitted += 1;
	const result = await bb.tribunal.submit({ ...transition.tribunal, at });
	if (result.admitted) {
		tally.admitted += 1;
		if (result.folded) {
			tally.folded += 1;
		}
		return;
	}
	tally.suppressed += 1;
}

async function applyTransition(
	bb: Blackboard,
	transition: Transition,
	notifications: RuntimeNotification[],
	verifications: RunOnceResult["verifications"],
	tally: TribunalTally,
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
			//
			// TF-0098：在 effects 生效**之前**采集上下文面回退快照。这是上下文
			// 回退的唯一依据——之后采集就晚了（旧值已被覆盖）。
			const effects = verified.blackboardEffects;
			const effectKeys = [
				...(effects?.publish ?? []).map((e) => e.key),
				...(effects?.update ?? []).map((e) => e.key),
			];
			let rollback = verified.rollback;
			if (effectKeys.length > 0) {
				try {
					const context = await captureContextRollback(
						registryContextStore(bb),
						effectKeys,
					);
					rollback = { ...verified.rollback, context };
				} catch {
					// 快照采集失败不阻塞 apply，只是该键没有恢复点
				}
			}
			await bb.checkpoints.save(
				{ ...verified, lifecycle: "applied", rollback },
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
			const at = new Date().toISOString();
			notifications.push({
				message: transition.message,
				severity: transition.severity,
			});
			await event(bb, "notify_human", transition);
			await offerToTribunal(bb, transition, tally, at);
			return true;
		}
		case "notify_session": {
			// the automaton only NAMES the target; actual delivery into the
			// live session is reconciliation's job (it knows what is alive)
			await event(bb, "notify_session", {
				writer: transition.writerId,
				message: transition.message,
				stale: transition.stale,
			});
			return true;
		}
	}
}

/**
 * Runtime (skeleton section 四): the module composer. One run =
 * snapshot → automaton → apply each transition → re-anchor drifted interfaces.
 *
 * - exclusive: a pid lock (O_EXCL) makes concurrent runOnce structurally
 *   impossible — watcher, `workbench sync`, and POST /api/sync all funnel
 *   through here, and a contended cycle is reported as `busy`, never raced;
 * - idempotent: a consistent world produces zero transitions and zero writes;
 * - re-entrant: every transition is judged against the ENTRY snapshot only;
 *   effects it triggers are picked up by the next run, never recursively;
 * - observable: every applied transition and verification lands in the event
 *   log.
 */
export async function runOnce(bb: Blackboard): Promise<RunOnceResult> {
	const lock = await acquireRunLock(bb.paths.root);
	if (!lock.acquired) {
		return {
			transitions: [],
			applied: 0,
			notifications: [],
			verifications: [],
			reanchored: [],
			dispatches: [],
			tribunal: emptyTribunalTally(),
			busy: true,
			lockHolder: lock.holder,
		};
	}
	try {
		return await runOnceLocked(bb);
	} finally {
		await lock.release();
	}
}

async function runOnceLocked(bb: Blackboard): Promise<RunOnceResult> {
	const snapshot: WorldSnapshot = await bb.snapshot();
	const transitions = evaluate(snapshot);

	const notifications: RuntimeNotification[] = [];
	const verifications: RunOnceResult["verifications"] = [];
	const tally = emptyTribunalTally();
	let applied = 0;
	for (const transition of transitions) {
		if (
			await applyTransition(bb, transition, notifications, verifications, tally)
		) {
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
				async (message, severity, tribunal) => {
					const at = new Date().toISOString();
					notifications.push({ message, severity });
					await event(bb, "notify_human", { message, severity });
					if (tribunal) {
						tally.submitted += 1;
						const result = await bb.tribunal.submit({ ...tribunal, at });
						if (result.admitted) {
							tally.admitted += 1;
							if (result.folded) {
								tally.folded += 1;
							}
						} else {
							tally.suppressed += 1;
						}
					}
				},
			)),
		);
	}

	// Deferrals that lapsed while the runtime was not running reopen here,
	// under the single-writer run lock — a shelve is never a dismissal.
	await bb.tribunal.expireShelved();

	return {
		transitions,
		applied,
		notifications,
		verifications,
		reanchored,
		dispatches,
		tribunal: tally,
	};
}
