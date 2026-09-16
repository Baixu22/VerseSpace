import type { Blackboard } from "../blackboard";

import type { ResumeNote } from "../chat/resume";

export interface ReadSetBaseline {
	footprintSeq?: number;
	eventSeq?: number;
	eventId?: string;
}

export function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

export function payloadOf(event: {
	payload: unknown;
}): Record<string, unknown> | null {
	const payload = event.payload;
	return payload && typeof payload === "object" && !Array.isArray(payload)
		? (payload as Record<string, unknown>)
		: null;
}

export function pathMatches(value: unknown, path: string): boolean {
	return typeof value === "string" && value.replace(/\\/g, "/") === path;
}

export async function latestLeaveEvent(
	bb: Blackboard,
	writerId: string,
): Promise<{
	eventSeq: number | null;
	eventId: string | null;
	footprintSeq?: number;
}> {
	const events = await bb.events.query({ type: "thread.left" });
	let found: {
		eventSeq: number | null;
		eventId: string | null;
		footprintSeq?: number;
	} = {
		eventSeq: null,
		eventId: null,
	};
	for (const event of events) {
		const payload = payloadOf(event);
		if (payload?.threadId !== writerId) {
			continue;
		}
		const seq = finiteNonNegative(event.eventSeq);
		const footprintSeq = finiteNonNegative(payload.footprintSeq);
		found = {
			eventSeq: seq ?? null,
			eventId: event.id ?? null,
			...(footprintSeq === undefined ? {} : { footprintSeq }),
		};
	}
	return found;
}

export function normalizeBaseline(
	input: ReadSetBaseline | ResumeNote["leaveSignature"] | undefined,
	latest: Awaited<ReturnType<typeof latestLeaveEvent>>,
): {
	footprintSeq: number;
	eventSeq: number | null;
	eventId: string | null;
} | null {
	// An explicitly supplied legacy note without a durable footprint boundary
	// is unknown; borrowing the newest leave would compare the wrong visit.
	const footprintSeq = input
		? finiteNonNegative(input.footprintSeq)
		: latest.footprintSeq;
	if (footprintSeq === undefined) {
		return null;
	}
	return {
		footprintSeq,
		eventSeq: input
			? (finiteNonNegative(input.eventSeq) ?? null)
			: latest.eventSeq,
		eventId:
			input && typeof input.eventId === "string"
				? input.eventId
				: input
					? null
					: latest.eventId,
	};
}

export function baselineClaimRef(
	lines: Awaited<ReturnType<Blackboard["sessions"]["footprint"]>>,
	path: string,
	baselineSeq: number,
): { seq: number; eventId?: string } | null {
	let found: { seq: number; eventId?: string } | null = null;
	for (const line of lines) {
		if (line.seq > baselineSeq) {
			break;
		}
		if (
			[...line.used, ...line.generated].some((claim) =>
				pathMatches(claim.path, path),
			)
		) {
			found = { seq: line.seq, eventId: line.eventId };
		}
	}
	return found;
}
