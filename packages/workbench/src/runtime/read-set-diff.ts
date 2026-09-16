import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Blackboard } from "../blackboard";
import { hashPathClaim } from "../blackboard/footprint";
import type { ResumeNote } from "../chat/resume";

import { diffFor, spanInvalidated } from "./premises";

import type { ReadSetBaseline } from "./restore-baseline";
import {
	baselineClaimRef,
	latestLeaveEvent,
	normalizeBaseline,
} from "./restore-baseline";
import { postLeaveWriters } from "./restore-writers";

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

export function toolNamesForUnsupported(
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

export async function isDirectoryClaim(
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

export type { ReadSetBaseline } from "./restore-baseline";
