import { evaluate } from "../automaton/evaluator";
import type { Blackboard } from "../blackboard";
import { acquireRunLock } from "../fs/lockfile";
import {
	type DispatchResult,
	recoverInterruptedDispatches,
	runScheduler,
} from "../scheduler/dispatch";
import type { WorldSnapshot } from "../types/snapshot";
import { applyTransition } from "./apply";
import { event } from "./events";
import {
	emptyTribunalTally,
	type RunOnceResult,
	type RuntimeNotification,
} from "./types";

export {
	emptyTribunalTally,
	type RunOnceResult,
	type RuntimeNotification,
	type TribunalTally,
} from "./types";

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
			recovered: [],
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
	// TF-0203: repair interrupted dispatches before taking the snapshot, so the
	// automaton and the scheduler both see the repaired world in this cycle.
	const recovered = await recoverInterruptedDispatches(bb);
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
		recovered,
		tribunal: tally,
	};
}
