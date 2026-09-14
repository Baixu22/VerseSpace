import type { Blackboard } from "../blackboard";
import type { TribunalEnvelope } from "../types/tribunal";

export type SchedulerNotify = (
	message: string,
	severity: "info" | "warning" | "error",
	tribunal?: TribunalEnvelope,
) => Promise<void>;

/** Manual dispatch uses the same event log and tribunal as the runtime callback. */
export function schedulerNotifier(bb: Blackboard): SchedulerNotify {
	return async (message, severity, tribunal) => {
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "scheduler",
			type: "notify_human",
			payload: { message, severity },
		});
		if (tribunal) await bb.tribunal.submit(tribunal);
	};
}
