import type { Blackboard } from "../../blackboard";
import type { Workspot, WorkspotStatus } from "../../types/workspot";

/** The workspot row dispatch writes in phase 1 and phase 3 — one claim shape. */
export function claimOf(
	workspot: Workspot,
	goalId: string,
	status: WorkspotStatus,
): Workspot {
	return {
		...workspot,
		status,
		primaryTask: goalId,
		currentTask: undefined,
		binding: "primary",
	};
}

/**
 * Put a workspot back to `idle` after a failed dispatch step.
 *
 * Returns false when even the rollback write failed; the caller says so in its
 * reason instead of pretending the world is clean — `runOnce` is the backstop
 * either way, because an `initializing` row is exactly what it repairs.
 */
export async function restoreIdle(
	bb: Blackboard,
	workspot: Workspot,
	cause: string,
): Promise<boolean> {
	try {
		await bb.state.workspots.save({
			...workspot,
			status: "idle",
			currentTask: undefined,
			binding: "primary",
		});
		return true;
	} catch (error) {
		await bb.events
			.append({
				timestamp: new Date().toISOString(),
				source: "scheduler",
				type: "dispatch_rollback_failed",
				payload: {
					workspotId: workspot.id,
					cause,
					detail: error instanceof Error ? error.message : String(error),
				},
			})
			.catch(() => {});
		return false;
	}
}
