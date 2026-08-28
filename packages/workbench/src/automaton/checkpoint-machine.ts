import type { WorldSnapshot } from "../types/snapshot";
import type { Transition } from "../types/transitions";

/**
 * Checkpoint state machine: draft → pending → verified → applied, with
 * failed / awaiting_review / rejected branches.
 *
 * The automaton only decides what SHOULD happen next; the Runtime executes:
 * - `request_verification` = set lifecycle to `pending`, run the Verifier,
 *   and write the outcome (verified → move to verified zone; failed → move to
 *   failed zone; human-review → awaiting_review, stays in staging).
 * - `checkpoint_lifecycle verified→applied` = apply blackboardEffects (if any)
 *   then mark the checkpoint applied.
 *
 * The failed zone is intentionally silent here: verification failures are
 * notified once by the Runtime when the result lands, and `doctor` reports
 * residue. A failed checkpoint leaves the system only via human action.
 */
export function evaluateCheckpoints(snapshot: WorldSnapshot): Transition[] {
	const transitions: Transition[] = [];
	const byId = (a: { id: string }, b: { id: string }) =>
		a.id.localeCompare(b.id);

	for (const checkpoint of [...snapshot.checkpoints.staging].sort(byId)) {
		if (checkpoint.lifecycle === "draft") {
			if (checkpoint.verification) {
				transitions.push({ type: "request_verification", cpId: checkpoint.id });
			} else {
				transitions.push({
					type: "notify_human",
					message: `checkpoint ${checkpoint.id} 没有 verification 策略，停留在 draft`,
					severity: "warning",
				});
			}
		} else if (checkpoint.lifecycle === "awaiting_review") {
			transitions.push({
				type: "notify_human",
				message: `checkpoint ${checkpoint.id} 等待人工审查（workbench checkpoint review ${checkpoint.id}）`,
				severity: "info",
			});
		}
		// pending: owned by the Verifier runtime
	}

	for (const checkpoint of [...snapshot.checkpoints.verified].sort(byId)) {
		if (checkpoint.lifecycle === "verified") {
			transitions.push({
				type: "checkpoint_lifecycle",
				cpId: checkpoint.id,
				from: "verified",
				to: "applied",
			});
		}
	}

	return transitions;
}
