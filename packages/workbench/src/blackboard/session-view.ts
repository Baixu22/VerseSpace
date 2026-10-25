import { claimObservation, claimVersion } from "./claim-version";
import type { FootprintLine, FootprintUsed } from "./session-types";

export type ObservedRead = FootprintUsed & {
	seq: number;
	actingAgent?: string;
	eventId?: string;
	eventSeq?: number;
};
export interface ReadSetView {
	/** Last observation per path, retained for existing inspection callers. */
	reads: Map<string, ObservedRead>;
	/** All non-superseded observations, each with its own version and span. */
	readFragments: Map<string, ObservedRead[]>;
	writes: Array<ObservedRead & { ts: string }>;
}

function supersedes(next: ObservedRead, previous: ObservedRead): boolean {
	// An unmeasured read cannot erase a measured premise.
	if (claimVersion(next) == null) return false;
	if (next.observation) {
		const evidence = claimObservation(next);
		if (
			evidence.source === "unknown" ||
			(evidence.source === "tool-observed" && evidence.binding !== "matched")
		)
			return false;
	}
	if (previous.version != null && next.version == null) return false;
	if (next.span?.start === 1 && next.span.end === Number.MAX_SAFE_INTEGER)
		return true;
	if (!next.span) return !previous.span;
	if (!previous.span) return false;
	// Same coordinates explicitly reread: refresh that observation only. A
	// partially overlapping range never implies the rest was reread. These are
	// input observations, not evidence that a derived plan/product was repaired.
	if (
		next.span.start === previous.span.start &&
		next.span.end === previous.span.end
	)
		return true;
	return (
		claimVersion(next) === claimVersion(previous) &&
		next.span.start <= previous.span.start &&
		next.span.end >= previous.span.end
	);
}

export function foldReadSet(
	lines: FootprintLine[],
	uptoSeq?: number,
): ReadSetView {
	const reads = new Map<string, ObservedRead>();
	const readFragments = new Map<string, ObservedRead[]>();
	const writes: Array<FootprintUsed & { seq: number; ts: string }> = [];
	for (const line of lines) {
		if (uptoSeq !== undefined && line.seq > uptoSeq) {
			break;
		}
		for (const used of line.used) {
			// A content-reading tool observed the body, even if it never
			// edited the file. Replay whole reads as 1..EOF so layer 3 cannot
			// mistake code review for a signature-only dependency. Deriving
			// this from existing facets also repairs old logs without a migration;
			// the ordinary span claim survives real fork inheritance unchanged.
			const span =
				used.span ??
				(["Read", "Bash", "PowerShell"].includes(String(line.facets?.tool))
					? { start: 1, end: Number.MAX_SAFE_INTEGER }
					: undefined);
			const observed = {
				...used,
				...(span ? { span } : {}),
				seq: line.seq,
				actingAgent: line.agent,
				eventId: line.eventId,
				eventSeq: line.eventSeq,
			};
			reads.set(used.path, observed);
			readFragments.set(used.path, [
				...(readFragments.get(used.path) ?? []).filter(
					(old) => !supersedes(observed, old),
				),
				observed,
			]);
		}
		for (const gen of line.generated) {
			writes.push({ ...gen, seq: line.seq, ts: line.timestamp });
			// the writer's own write supersedes what it read before
			reads.set(gen.path, { ...gen, seq: line.seq });
			// Preserve the existing own-write observation contract, except that an
			// unmeasured write cannot silently discard known input versions.
			const observed = { ...gen, seq: line.seq };
			readFragments.set(
				gen.path,
				claimVersion(gen) != null
					? [observed]
					: [...(readFragments.get(gen.path) ?? []), observed],
			);
		}
	}
	return { reads, readFragments, writes };
}
