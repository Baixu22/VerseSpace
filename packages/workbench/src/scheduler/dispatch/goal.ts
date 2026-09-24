import type { Blackboard } from "../../blackboard";
import { envelopes } from "../../tribunal/envelopes";
import { type SchedulerNotify, schedulerNotifier } from "../notifications";
import { performDispatch } from "./perform";
import type { DispatchResult } from "./types";

export async function dispatchGoal(
	bb: Blackboard,
	goalId: string,
	workspotId?: string,
	options: { force?: boolean; notify?: SchedulerNotify } = {},
): Promise<DispatchResult> {
	const notify = options.notify ?? schedulerNotifier(bb);
	const result = await performDispatch(bb, goalId, workspotId, {
		...options,
		notify,
	});
	if (!result.ok) {
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "scheduler",
			type: "dispatch_failed",
			payload: { ...result },
		});
		// Structured refusals already carry their own diagnostic card.
		if (!result.error) {
			const card = envelopes.dispatchFailed(
				goalId,
				result.workspotId ?? workspotId,
				result.reason ?? "调度器未给出原因",
			);
			await notify(card.sbar.situation, "error", card).catch((err) => {
				console.error(`[scheduler] 派发失败告警投递失败（${goalId}）:`, err);
			});
		}
	}
	return result;
}
