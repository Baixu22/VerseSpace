import type { Blackboard } from "../blackboard";
import type { ChatThreads } from "../chat/threads";
import { drainPremiseQueue } from "../runtime/delivery";
import { reconcilePremises } from "../runtime/premises";

/**
 * TF-0260 (F-06): the background tick that reconciles premises and drains the
 * notice queue, with the config-read failure given a distinct identity.
 *
 * Before this, `server.ts` inlined the tick and swallowed a config-read failure
 * with `bb.config.load().catch(() => null)`, then kept draining with an
 * undefined token budget. A corrupt `workbench.yaml` was indistinguishable
 * from "there was nothing to deliver". Here the read failure is:
 *   - counted (`configLoadFailures`) and its message kept (`lastConfigError`),
 *     surfaced on `/api/state` separately from the generic reconcile failures;
 *   - logged and emitted as a one-shot `config_load_failed` event (only when
 *     the error text changes, so a persistent corruption does not spam the log
 *     every 15s);
 *   - non-fatal: the tick keeps draining under the explicit default budget so
 *     notices still flow. Fail-open is deliberate — a stale custom token budget
 *     must not silence premise notices; the corruption is recorded, not hidden.
 */
export interface ReconcileStats {
	reconcileFailures: number;
	lastReconcileError: string | null;
	configLoadFailures: number;
	lastConfigError: string | null;
	/** Whether the most recent drain pass completed without throwing. */
	lastDrainOk: boolean;
}

export function newReconcileStats(): ReconcileStats {
	return {
		reconcileFailures: 0,
		lastReconcileError: null,
		configLoadFailures: 0,
		lastConfigError: null,
		lastDrainOk: false,
	};
}

const DEFAULT_NOTICE_TOKEN_BUDGET = 300;

export async function runReconcileTick(
	bb: Blackboard,
	chat: ChatThreads,
	stats: ReconcileStats,
): Promise<void> {
	try {
		await reconcilePremises(bb);
	} catch (err) {
		stats.reconcileFailures++;
		stats.lastReconcileError = err instanceof Error ? err.message : String(err);
		console.error(
			`[workbench-ui] reconcilePremises failed (#${stats.reconcileFailures}):`,
			err,
		);
	}

	// Config read is a first-class failure, not a silent null. On failure keep
	// the default budget so the drain still runs — but record the corruption so
	// `/api/state`, the log and the event stream can tell it apart from silence.
	let tokenBudget = DEFAULT_NOTICE_TOKEN_BUDGET;
	try {
		const config = await bb.config.load();
		tokenBudget = config.chat.noticeTokenBudget;
	} catch (err) {
		stats.configLoadFailures++;
		const message = err instanceof Error ? err.message : String(err);
		const changed = message !== stats.lastConfigError;
		stats.lastConfigError = message;
		console.error(
			`[workbench-ui] config load failed (#${stats.configLoadFailures}), draining with default budget:`,
			err,
		);
		// One event per distinct error: a persistent corruption is a standing
		// condition, not a fresh incident every tick.
		if (changed) {
			try {
				await bb.events.append({
					timestamp: new Date().toISOString(),
					source: "runtime",
					type: "config_load_failed",
					payload: { error: message, usingDefaultBudget: true },
				});
			} catch (appendError) {
				// The tick must never reject: a failed audit write is itself a
				// visible failure (logged), not a reason to kill the loop. Found by
				// the corrupt-config test, whose cleanup races the append.
				console.error(
					"[workbench-ui] config_load_failed event append failed:",
					appendError,
				);
			}
		}
	}

	try {
		await drainPremiseQueue(bb, {
			tokenBudget,
			deliver: (writerId, message, noticeId) =>
				chat.notifySession(writerId, message, noticeId),
		});
		stats.lastDrainOk = true;
	} catch (err) {
		stats.lastDrainOk = false;
		stats.reconcileFailures++;
		stats.lastReconcileError = err instanceof Error ? err.message : String(err);
		console.error(
			`[workbench-ui] drainPremiseQueue failed (#${stats.reconcileFailures}):`,
			err,
		);
	}
}
