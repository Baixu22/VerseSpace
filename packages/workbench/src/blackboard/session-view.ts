import type { FootprintLine, FootprintUsed } from "./session-types";

export function foldReadSet(
	lines: FootprintLine[],
	uptoSeq?: number,
): {
	reads: Map<string, FootprintUsed & { seq: number }>;
	writes: Array<FootprintUsed & { seq: number; ts: string }>;
} {
	const reads = new Map<string, FootprintUsed & { seq: number }>();
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
			reads.set(used.path, {
				...used,
				...(span ? { span } : {}),
				seq: line.seq,
			});
		}
		for (const gen of line.generated) {
			writes.push({ ...gen, seq: line.seq, ts: line.timestamp });
			// the writer's own write supersedes what it read before
			reads.set(gen.path, { ...gen, seq: line.seq });
		}
	}
	return { reads, writes };
}
