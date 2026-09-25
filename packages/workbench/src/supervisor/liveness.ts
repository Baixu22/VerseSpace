/**
 * Liveness of a long-lived child (TF-0205).
 *
 * The sidecar lane learned this the hard way: a `heartbeat` every 15s and a 45s
 * silence timeout (3× the interval, tolerating one missed tick) is how the
 * parent tells "the child is frozen" apart from "the child is legitimately
 * running a 20-minute tool call". What it also learned — issues #398/#402 — is
 * that EPIPE on a pipe is NOT proof the other end is gone: any pipe in the
 * process can blip, and treating that as death silently kills every in-flight
 * turn. Only stdin EOF is authoritative.
 *
 * The mainline had the sending half of that idea nowhere and the receiving half
 * was missing entirely: `runClaudeTurn` waited on the child's exit and on a
 * result line, so a child that neither spoke nor exited hung the turn forever.
 * This module is the receiving half, written against the two rules above:
 *
 * - silence is measured, not assumed: `stalled` (soft) names it so a human can
 *   see it, `unresponsive` (hard) is the terminal call;
 * - a broken pipe is reported as `pipe_broken` and does NOT end anything; it is
 *   folded into `exited` only when the child actually exits.
 *
 * The caller still owns the decision to terminate — a long tool call and a
 * frozen CLI look identical from the outside. The module kills nothing on its
 * own; a caller that knows the stakes opts in by passing `terminate`, and only
 * then does the hard threshold kill the child and name the outcome
 * `judged_silent` (distinct from the report-only `unresponsive`). The child's
 * real exit that follows then runs the caller's ordinary exit cleanup.
 */

/** Expected gap between producer events, and therefore the check rhythm. */
export const HEARTBEAT_INTERVAL_MS = 15_000;
/** Silence after which the child is named as stalled: 3× the interval. */
export const STALL_MS = 3 * HEARTBEAT_INTERVAL_MS;
/** Silence after which the child is called unresponsive: 3× the stall window. */
export const UNRESPONSIVE_MS = 3 * STALL_MS;

export type LivenessVerdict =
	/** Silent long enough to be worth naming; possibly just a long tool call. */
	| { kind: "stalled"; silentMs: number; lastEventAt: number | null }
	/** Silent long enough that waiting longer is not defensible. Terminal.
	 *  Report-only: reached when no `terminate` action was wired. */
	| { kind: "unresponsive"; silentMs: number; lastEventAt: number | null }
	/** Hard threshold reached AND the caller-provided `terminate` action was
	 *  invoked to kill the child. Terminal — distinct from `unresponsive` (same
	 *  silence, no kill) and from `pipe_broken` (never terminal). */
	| { kind: "judged_silent"; silentMs: number; lastEventAt: number | null }
	/** A write to the child failed (EPIPE). Recoverable; not proof of death. */
	| { kind: "pipe_broken"; detail: string }
	/** The child is gone (exit observed). Authoritative. */
	| { kind: "exited"; detail: string; afterPipeBreak: boolean };

export interface LivenessOptions {
	/** Check rhythm. Defaults to the heartbeat interval. */
	tickMs?: number;
	stallMs?: number;
	/** Set to 0 to report `stalled` only and never call the child unresponsive. */
	unresponsiveMs?: number;
	/**
	 * Hard-threshold action. When provided, reaching `unresponsiveMs` invokes it
	 * to kill the child and the terminal verdict is `judged_silent` instead of
	 * the report-only `unresponsive`. The child's real exit then runs the
	 * caller's ordinary exit cleanup (error event + status idle). Omit to keep
	 * the pure report-only behaviour.
	 */
	terminate?: () => void | Promise<void>;
	now?: () => number;
	onVerdict: (verdict: LivenessVerdict) => void;
}

export interface LivenessWatch {
	/** Any event from the child resets the silence window. */
	note(at?: number): void;
	/** A write to the child failed. Reported once; does not end the watch. */
	pipeBroken(detail: string): void;
	/** The child is gone. Ends the watch. */
	exited(detail: string): void;
	/** Stop watching without a verdict (the child was killed deliberately). */
	stop(): void;
	/** Current verdict, for assertions and for later readers of the handle. */
	verdict(): LivenessVerdict | null;
}

export function watchLiveness(options: LivenessOptions): LivenessWatch {
	const now = options.now ?? (() => Date.now());
	const tickMs = Math.max(1, options.tickMs ?? HEARTBEAT_INTERVAL_MS);
	const stallMs = options.stallMs ?? STALL_MS;
	const unresponsiveMs = options.unresponsiveMs ?? UNRESPONSIVE_MS;

	let lastEventAt: number | null = now();
	let reportedStall = false;
	let reportedUnresponsive = false;
	let pipeBrokenDetail: string | null = null;
	let current: LivenessVerdict | null = null;
	let stopped = false;
	let timer: ReturnType<typeof setInterval> | null = null;

	const finish = (verdict: LivenessVerdict): void => {
		current = verdict;
		options.onVerdict(verdict);
	};

	const stopClock = (): void => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	};

	const check = (): void => {
		if (stopped) {
			return;
		}
		const silentMs = now() - (lastEventAt ?? now());
		if (unresponsiveMs > 0 && silentMs >= unresponsiveMs) {
			if (!reportedUnresponsive) {
				reportedUnresponsive = true;
				stopClock();
				if (options.terminate) {
					// The caller wired a kill: do it, then name the outcome
					// `judged_silent` so the exit that follows reads as a deliberate
					// termination rather than a bare report-only `unresponsive`.
					//
					// TF-0269 (OPEN-4): a rejected — or synchronously throwing —
					// `terminate()` used to disappear entirely, while the verdict below
					// still read `judged_silent`: "we deliberately ended it", with the
					// child possibly still running. The verdict stands (the decision
					// WAS made, and the caller's exit cleanup still runs when the child
					// really goes); the failure is named instead of dropped.
					try {
						void Promise.resolve(options.terminate()).catch((error) => {
							console.error(
								"[supervisor] liveness terminate 失败，子进程可能仍在运行:",
								error,
							);
						});
					} catch (error) {
						console.error(
							"[supervisor] liveness terminate 同步抛出，子进程可能仍在运行:",
							error,
						);
					}
					finish({ kind: "judged_silent", silentMs, lastEventAt });
				} else {
					finish({ kind: "unresponsive", silentMs, lastEventAt });
				}
			}
			return;
		}
		if (silentMs >= stallMs && !reportedStall) {
			reportedStall = true;
			finish({ kind: "stalled", silentMs, lastEventAt });
		}
	};

	timer = setInterval(check, tickMs);
	// A liveness probe must never be the reason a process stays alive.
	(timer as { unref?: () => void }).unref?.();

	return {
		note(at?: number) {
			if (stopped) {
				return;
			}
			lastEventAt = at ?? now();
			// `reportedStall` is intentionally NOT reset here. A long run
			// interleaves tool output with silences, so resetting on every event
			// let a busy-but-quiet child re-trip the soft warning again and again
			// and flood the log. One soft `stalled` per watch is enough to name
			// the silence; the terminal `unresponsive` verdict is what acts. Note
			// still moves `lastEventAt`, so real activity keeps pushing the
			// unresponsive deadline out — a genuine long tool call is never judged
			// dead, it just doesn't get a second warning.
		},
		pipeBroken(detail: string) {
			if (stopped || pipeBrokenDetail !== null) {
				return;
			}
			pipeBrokenDetail = detail;
			finish({ kind: "pipe_broken", detail });
		},
		exited(detail: string) {
			if (stopped) {
				return;
			}
			const afterPipeBreak = pipeBrokenDetail !== null;
			// Set the flag before reporting so a re-entrant call cannot report
			// twice — but report through `finish`, which no longer re-checks it.
			// (Checking it in both places made the terminal verdict unreachable.)
			stopped = true;
			stopClock();
			finish({ kind: "exited", detail, afterPipeBreak });
		},
		stop() {
			stopped = true;
			stopClock();
		},
		verdict() {
			return current;
		},
	};
}
