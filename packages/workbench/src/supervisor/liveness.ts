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
 * Callers stay in charge of the response: this module never kills a process.
 * A long tool call and a frozen CLI look identical from the outside, so the
 * decision to terminate belongs to the caller that knows the stakes.
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
	/** Silent long enough that waiting longer is not defensible. Terminal. */
	| { kind: "unresponsive"; silentMs: number; lastEventAt: number | null }
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
				finish({ kind: "unresponsive", silentMs, lastEventAt });
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
			// Events after a stall report mean the child was merely busy: the
			// next silence gets its own report rather than staying suppressed.
			reportedStall = false;
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
