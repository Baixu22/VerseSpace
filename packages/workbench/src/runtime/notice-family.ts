import type { WorkbenchEvent } from "../types/event";
import type { StalePremiseClaim } from "./premises";

export interface NoticeFamilyFold {
	familyId: string;
	windowMinutes: number;
	writerIds: string[];
	paths: string[];
}

const WINDOW_MINUTES = 30;
const normalize = (path: string) => path.replace(/\\/g, "/");
const payloadOf = (event: WorkbenchEvent) =>
	event.payload && typeof event.payload === "object"
		? (event.payload as Record<string, unknown>)
		: {};

function rootOf(writer: string, parents: Map<string, string>): string | null {
	const seen = new Set<string>();
	let current = writer;
	while (parents.has(current)) {
		if (seen.has(current)) return null;
		seen.add(current);
		current = parents.get(current)!;
	}
	return current;
}

/**
 * Presentation only: world detection/seals/acknowledgements keep full claims.
 * Lineage alone is insufficient: match the latest actual write's version and age.
 */
export function foldNoticeFamilies(
	notices: ReadonlyArray<{
		writerId: string;
		claims: readonly StalePremiseClaim[];
	}>,
	events: WorkbenchEvent[],
	now = Date.now(),
): Map<string, NoticeFamilyFold> {
	const parents = new Map<string, string>();
	const writes = new Map<
		string,
		{ writer: unknown; version: unknown; at: number }
	>();
	for (const event of events) {
		const payload = payloadOf(event);
		if (
			event.type === "thread.forked" &&
			typeof payload.threadId === "string" &&
			typeof payload.sourceThreadId === "string"
		) {
			parents.set(payload.threadId, payload.sourceThreadId);
		}
		if (event.type !== "footprint" || !Array.isArray(payload.generated))
			continue;
		for (const value of payload.generated) {
			if (!value || typeof value !== "object" || typeof value.path !== "string")
				continue;
			// Even an unidentifiable latest writer supersedes earlier attribution.
			writes.set(normalize(value.path), {
				writer: payload.writer,
				version: value.version,
				at: Date.parse(event.timestamp),
			});
		}
	}
	const folded = new Map<string, NoticeFamilyFold>();
	for (const notice of notices) {
		const familyId = rootOf(notice.writerId, parents);
		if (!familyId) continue;
		const paths = new Set<string>();
		const writers = new Set<string>();
		for (const claim of notice.claims) {
			const write = writes.get(normalize(claim.path));
			if (
				!write ||
				typeof write.writer !== "string" ||
				write.writer === notice.writerId ||
				!Number.isFinite(write.at) ||
				write.at > now ||
				now - write.at > WINDOW_MINUTES * 60_000 ||
				write.version === undefined ||
				write.version !== claim.currentVersion ||
				rootOf(write.writer, parents) !== familyId
			)
				continue;
			paths.add(claim.path);
			writers.add(write.writer);
		}
		if (paths.size)
			folded.set(notice.writerId, {
				familyId,
				windowMinutes: WINDOW_MINUTES,
				writerIds: [...writers].sort(),
				paths: [...paths].sort(),
			});
	}
	return folded;
}
