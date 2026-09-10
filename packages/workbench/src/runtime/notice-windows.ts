import type { WorkbenchEvent } from "../types/event";

/** A successful deferred ack owns activity from its provider attempt, not only
 * activity after the ack. Unknown/old markers retain legacy conservative bounds. */
export function deliveryWindows(timeline: WorkbenchEvent[]) {
	const indexes = new Map(timeline.map((event, index) => [event.id, index]));
	const windows: Array<{ delivery: number; start: number; end: number }> = [];
	const previous = new Map<string, (typeof windows)[number]>();
	for (const [index, event] of timeline.entries()) {
		if (event.type !== "premise_notice_delivered") continue;
		const payload = event.payload as {
			writer?: unknown;
			activityAfterEventId?: unknown;
		} | null;
		if (typeof payload?.writer !== "string" || !payload.writer) continue;
		const prior = previous.get(payload.writer);
		const marker =
			typeof payload.activityAfterEventId === "string"
				? indexes.get(payload.activityAfterEventId)
				: undefined;
		const after =
			marker !== undefined && marker < index && marker >= (prior?.delivery ?? 0)
				? marker
				: index;
		const window = { delivery: index, start: after + 1, end: timeline.length };
		if (prior) prior.end = window.start;
		previous.set(payload.writer, window);
		windows.push(window);
	}
	return windows;
}
