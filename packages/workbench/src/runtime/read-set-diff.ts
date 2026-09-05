import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Blackboard } from "../blackboard";
import { hashPathClaim } from "../blackboard/footprint";
import type { ResumeNote } from "../chat/resume";
import type { WorkbenchEvent } from "../types/event";
import { diffFor, spanInvalidated } from "./premises";

/** The persisted leave boundary used by the restore-time read-set check. */
export interface ReadSetBaseline {
	footprintSeq?: number;
	eventSeq?: number;
	eventId?: string;
}

export interface ReadSetFact {
	path: string;
	observedVersion: string;
	currentVersion: string | null;
	/** Best-effort attribution from post-leave generated footprint events. */
	writerId: string | null;
	writerKind: string | null;
	writerLabel: string | null;
	diff?: string;
	/** Stable event/footprint references; no copied event body. */
	refs: string[];
	observedFootprintSeq: number;
	currentEventSeq: number | null;
}

export interface ReadSetDiff {
	status: "available" | "unknown";
	baseline: {
		footprintSeq: number;
		eventSeq: number | null;
		eventId: string | null;
	} | null;
	checkedAt: string;
	/**
	 * Read claims the coverage number is computed over: every recorded read
	 * MINUS directory claims. A `Grep` over `src/` records `src` as read, and a
	 * directory has no content version to compare — counting it either way
	 * would make the coverage number describe searches instead of file reads
	 * (TF-0129).
	 */
	compared: number;
	/** Of `compared`, the ones that had a version and were actually checked. */
	comparable: number;
	excludedDurable: number;
	/** Directory claims dropped before the coverage number (Grep / Glob). */
	excludedDirectories: number;
	unsupported: number;
	/** Tools whose FILE claims had no version and therefore were not compared. */
	uncoveredTools: string[];
	stale: ReadSetFact[];
}

function finiteNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

function payloadOf(event: {
	payload: unknown;
}): Record<string, unknown> | null {
	const payload = event.payload;
	return payload && typeof payload === "object" && !Array.isArray(payload)
		? (payload as Record<string, unknown>)
		: null;
}

function pathMatches(value: unknown, path: string): boolean {
	return typeof value === "string" && value.replace(/\\/g, "/") === path;
}

async function latestLeaveEvent(
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

function normalizeBaseline(
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

async function postLeaveWriters(
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

function baselineClaimRef(
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

/**
 * Tools whose file reads could not be compared.
 *
 * Keyed by the paths that actually landed in `unsupported`, so a `Grep` whose
 * only unversioned claim was the directory it searched does not show up as an
 * uncovered tool — it was never a file read to begin with (TF-0129).
 */
function toolNamesForUnsupported(
	lines: Awaited<ReturnType<Blackboard["sessions"]["footprint"]>>,
	baselineSeq: number,
	unsupportedPaths: Set<string>,
): string[] {
	const names = new Set<string>();
	for (const line of lines) {
		if (line.seq > baselineSeq) {
			break;
		}
		const tool = line.facets?.tool;
		if (
			typeof tool === "string" &&
			line.used.some((claim) =>
				unsupportedPaths.has(claim.path.replace(/\\/g, "/")),
			)
		) {
			names.add(tool);
		}
	}
	return [...names].sort();
}

/** A read claim that names a directory can never be version-compared. */
async function isDirectoryClaim(
	projectRoot: string,
	path: string,
): Promise<boolean> {
	const absolute = isAbsolute(path) ? path : join(projectRoot, path);
	try {
		return (await stat(absolute)).isDirectory();
	} catch {
		// Gone, or unreadable: we cannot prove it was a directory, so leave it
		// in `unsupported` rather than quietly shrinking the denominator.
		return false;
	}
}

/**
 * Compare the read-set held at leave with the repository now. This is a
 * read-only projection: it never emits stale events and never uses the
 * 30-minute live-writer window. Missing old leave baselines are explicit
 * `unknown`, rather than silently comparing the whole current footprint.
 */
export async function diffReadSet(
	bb: Blackboard,
	writerId: string,
	leave?: ReadSetBaseline | ResumeNote["leaveSignature"],
): Promise<ReadSetDiff> {
	const latest = await latestLeaveEvent(bb, writerId);
	const baseline = normalizeBaseline(leave, latest);
	const checkedAt = new Date().toISOString();
	if (!baseline) {
		return {
			status: "unknown",
			baseline: null,
			checkedAt,
			compared: 0,
			comparable: 0,
			excludedDurable: 0,
			excludedDirectories: 0,
			unsupported: 0,
			uncoveredTools: [],
			stale: [],
		};
	}

	const [view, lines, allEvents] = await Promise.all([
		bb.sessions.readSetView(writerId, baseline.footprintSeq),
		bb.sessions.footprint(writerId),
		bb.events.all(),
	]);
	const postLeave = await postLeaveWriters(
		bb,
		new Set(view.reads.keys()),
		{ eventSeq: baseline.eventSeq, eventId: baseline.eventId },
		allEvents,
	);
	const stale: ReadSetFact[] = [];
	let comparable = 0;
	let excludedDurable = 0;
	let excludedDirectories = 0;
	let unsupported = 0;
	const unsupportedPaths = new Set<string>();
	for (const [path, claim] of view.reads) {
		if (claim.durability === "durable") {
			excludedDurable += 1;
			continue;
		}
		if (claim.version == null) {
			// Grep / Glob record the directory they searched. It has no content
			// version, so counting it would make the coverage number describe
			// searches rather than file reads (TF-0129).
			if (await isDirectoryClaim(bb.projectRoot, path)) {
				excludedDirectories += 1;
				continue;
			}
			unsupported += 1;
			unsupportedPaths.add(path.replace(/\\/g, "/"));
			continue;
		}
		comparable += 1;
		const current = await hashPathClaim(bb.projectRoot, path);
		if (current.version === claim.version) {
			continue;
		}
		let diff: string | undefined;
		if (claim.span) {
			diff = await diffFor(bb, writerId, claim);
			if (!(await spanInvalidated(bb, claim, claim.span, diff))) {
				continue;
			}
		} else if (claim.durability === "volatile") {
			// A restore is a fact check, not an active notification. We still use
			// the captured diff when available; absent spool means diff is simply
			// unavailable, never that the claim is safe.
			diff = await diffFor(bb, writerId, claim);
		}
		const attribution = postLeave.get(path) ?? {
			writerId: null,
			writerKind: null,
			writerLabel: null,
			currentEventSeq: null,
			refs: [],
		};
		const original = baselineClaimRef(lines, path, baseline.footprintSeq);
		const refs = [
			...(original?.eventId
				? [`footprint:${original.eventId}`]
				: [`footprintSeq:${original?.seq ?? claim.seq}`]),
			...attribution.refs,
		];
		stale.push({
			path,
			observedVersion: claim.version,
			currentVersion: current.version ?? null,
			writerId: attribution.writerId,
			writerKind: attribution.writerKind,
			writerLabel: attribution.writerLabel,
			...(diff ? { diff } : {}),
			refs,
			observedFootprintSeq: claim.seq,
			currentEventSeq: attribution.currentEventSeq,
		});
	}
	return {
		status: "available",
		baseline: {
			footprintSeq: baseline.footprintSeq,
			eventSeq: baseline.eventSeq,
			eventId: baseline.eventId,
		},
		checkedAt,
		// Directory claims are out of the denominator: see `compared` above.
		compared: view.reads.size - excludedDirectories,
		comparable,
		excludedDurable,
		excludedDirectories,
		unsupported,
		uncoveredTools: toolNamesForUnsupported(
			lines,
			baseline.footprintSeq,
			unsupportedPaths,
		),
		stale,
	};
}
