export interface LifecycleEventLike {
	type: string;
	id?: string;
	eventSeq?: number;
	payload: unknown;
}

function payloadOf(event: LifecycleEventLike): Record<string, unknown> | null {
	const payload = event.payload;
	return payload && typeof payload === "object" && !Array.isArray(payload)
		? (payload as Record<string, unknown>)
		: null;
}

/**
 * Dismiss is an append-only observation. A later thread.left opens a new
 * visit, so an older dismiss must not suppress the new card.
 */
export function isResumeCardDismissed(
	events: LifecycleEventLike[],
	threadId: string,
	leaveEventId?: string | null,
): boolean {
	let leaveIndex = -1;
	let leaveSeq: number | null = null;
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index]!;
		if (event.type !== "thread.left") {
			continue;
		}
		const payload = payloadOf(event);
		if (payload?.threadId !== threadId) {
			continue;
		}
		if (leaveEventId) {
			if (event.id === leaveEventId) {
				leaveIndex = index;
				leaveSeq = event.eventSeq ?? null;
			}
			continue;
		}
		leaveIndex = index;
		leaveSeq = event.eventSeq ?? null;
	}
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index]!;
		if (event.type !== "thread.resume_action") {
			continue;
		}
		const payload = payloadOf(event);
		if (
			payload?.threadId !== threadId ||
			payload?.action !== "resume_card_dismissed"
		) {
			continue;
		}
		if (leaveSeq != null && event.eventSeq != null) {
			if (event.eventSeq > leaveSeq) {
				return true;
			}
			continue;
		}
		if (leaveIndex >= 0) {
			if (index > leaveIndex) {
				return true;
			}
			continue;
		}
		return true;
	}
	return false;
}
