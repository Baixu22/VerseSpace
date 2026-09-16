import type { DispatchResult } from "../scheduler/dispatch";
import type { Transition } from "../types/transitions";
import type { VerifyResult } from "../verifier";

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
