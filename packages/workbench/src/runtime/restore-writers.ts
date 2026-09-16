import type { Blackboard } from "../blackboard";

import type { WorkbenchEvent } from "../types/event";
import { finiteNonNegative, payloadOf } from "./restore-baseline";

export async function postLeaveWriters(
	bb: Blackboard,
	paths: Set<string>,
	boundary: { eventSeq: number | null; eventId: string | null },
	events: WorkbenchEvent[],
): Promise<
	Map<
		string,
		{
			writerId: string | null;
			writerKind: string | null;
			writerLabel: string | null;
			currentEventSeq: number | null;
			refs: string[];
		}
	>
> {
	const boundaryIndex = boundary.eventId
		? events.findIndex((event) => event.id === boundary.eventId)
		: -1;
	const candidates = new Map<
		string,
		{ writerId: string; eventSeq: number | null; ref: string }
	>();
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index]!;
		if (event.type !== "footprint") {
			continue;
		}
		const seq = finiteNonNegative(event.eventSeq);
		const afterBoundary =
			boundary.eventSeq !== null && seq !== undefined
				? seq > boundary.eventSeq
				: boundaryIndex >= 0
					? index > boundaryIndex
					: false;
		if (!afterBoundary) {
			continue;
		}
		const payload = payloadOf(event);
		const writer = typeof payload?.writer === "string" ? payload.writer : null;
		if (!writer || !Array.isArray(payload?.generated)) {
			continue;
		}
		for (const item of payload.generated) {
			if (!item || typeof item !== "object") {
				continue;
			}
			const rawPath = (item as { path?: unknown }).path;
			if (typeof rawPath !== "string") {
				continue;
			}
			const path = rawPath.replace(/\\/g, "/");
			if (!paths.has(path)) {
				continue;
			}
			candidates.set(path, {
				writerId: writer,
				eventSeq: seq ?? null,
				ref:
					event.id ?? (seq === undefined ? "event:unknown" : `eventSeq:${seq}`),
			});
		}
	}
	const writerIds = [
		...new Set([...candidates.values()].map((candidate) => candidate.writerId)),
	];
	const writerMetas = new Map(
		await Promise.all(
			writerIds.map(
				async (writerId) =>
					[writerId, await bb.sessions.get(writerId)] as const,
			),
		),
	);
	return new Map(
		[...candidates.entries()].map(([path, candidate]) => {
			const writer = writerMetas.get(candidate.writerId);
			return [
				path,
				{
					writerId: candidate.writerId,
					writerKind: writer?.kind ?? null,
					writerLabel: writer?.label ?? null,
					currentEventSeq: candidate.eventSeq,
					refs: [candidate.ref],
				},
			] as const;
		}),
	);
}
