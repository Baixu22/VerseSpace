import type { WorkbenchEvent } from "../types/event";

import { readSealRecord } from "./seal-counts";

export const NOTICE_OUTCOMES = [
	"repaired",
	"ignored",
	"sealed",
	"dismissed",
	"unknown",
] as const;

export type NoticeOutcome = (typeof NOTICE_OUTCOMES)[number];

export type UnknownReason =
	/** HTTP provider: post-notice reads are not observable at all (TF-0142). */
	| "unobservable"
	/** The writer has not produced another footprint round yet. */
	| "no-later-activity"
	/** The delivery's affected paths could not be recovered from the log. */
	| "unresolved-paths";

export interface LabeledDelivery {
	writer: string;
	noticeIds: string[];
	/** Affected paths, from the delivery payload or joined via noticeId. */
	paths: string[];
	at: string;
	outcome: NoticeOutcome;
	unknownReason?: UnknownReason;
	readObservability: "footprint" | "unobservable";
}

export const STALE = "premise_stale";

export const FOOTPRINT = "footprint";

export function payloadOf(event: WorkbenchEvent): Record<string, unknown> {
	return event.payload &&
		typeof event.payload === "object" &&
		!Array.isArray(event.payload)
		? (event.payload as Record<string, unknown>)
		: {};
}

export function stringsOf(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export function pathsOf(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: string[] = [];
	for (const item of value) {
		if (item && typeof item === "object" && !Array.isArray(item)) {
			const path = (item as Record<string, unknown>).path;
			if (typeof path === "string" && path.length > 0) {
				out.push(path);
			}
		}
	}
	return out;
}

export function orderOf(event: WorkbenchEvent, index: number): number {
	return Number.isSafeInteger(event.eventSeq)
		? (event.eventSeq as number)
		: Number.isSafeInteger(event.seq)
			? (event.seq as number)
			: index;
}

export function ordered(events: WorkbenchEvent[]): WorkbenchEvent[] {
	return events
		.map((event, index) => ({ event, index }))
		.sort(
			(a, b) =>
				orderOf(a.event, a.index) - orderOf(b.event, b.index) ||
				a.event.timestamp.localeCompare(b.event.timestamp),
		)
		.map(({ event }) => event);
}

export function covers(target: string, claim: string): boolean {
	return (
		target === claim ||
		claim.startsWith(`${target}/`) ||
		target.startsWith(`${claim}/`)
	);
}

export function judgeWindow(
	window: WorkbenchEvent[],
	writer: string,
	paths: string[],
	readObservability: "footprint" | "unobservable",
): { outcome: NoticeOutcome; unknownReason?: UnknownReason } {
	if (paths.length === 0) {
		return { outcome: "unknown", unknownReason: "unresolved-paths" };
	}

	let sealed = false;
	let ignored = false;
	let repaired = false;
	let touched = false;
	let rounds = 0;
	const readSoFar = new Set<string>();

	for (const event of window) {
		const seal = readSealRecord(event);
		if (seal) {
			if (
				seal.writer === writer &&
				seal.decision === "block" &&
				paths.some((path) => covers(seal.path, path))
			) {
				sealed = true;
			}
			continue;
		}
		if (event.type !== FOOTPRINT) {
			continue;
		}
		const payload = payloadOf(event);
		if (payload.writer !== writer) {
			continue;
		}
		rounds += 1;
		const reads = pathsOf(payload.used);
		const writes = pathsOf(payload.generated);
		for (const path of paths) {
			const wrote = writes.some((candidate) => covers(candidate, path));
			const read =
				readSoFar.has(path) ||
				reads.some((candidate) => covers(candidate, path));
			if (wrote || read) {
				touched = true;
			}
			if (!wrote) {
				continue;
			}
			// Read in an earlier round or in this same round both count: an agent
			// that re-reads and edits inside one turn did exactly what was asked.
			if (read) {
				repaired = true;
			} else {
				ignored = true;
			}
		}
		for (const path of paths) {
			if (reads.some((candidate) => covers(candidate, path))) {
				readSoFar.add(path);
			}
		}
	}

	if (sealed) {
		return { outcome: "sealed" };
	}
	// An unobservable channel can still be sealed (the seal is a hook, not a
	// read), but it can never produce repaired/ignored/dismissed — claiming
	// otherwise would read silence as evidence.
	if (readObservability === "unobservable") {
		return { outcome: "unknown", unknownReason: "unobservable" };
	}
	if (ignored) {
		return { outcome: "ignored" };
	}
	if (repaired) {
		return { outcome: "repaired" };
	}
	if (rounds === 0) {
		return { outcome: "unknown", unknownReason: "no-later-activity" };
	}
	// Re-read with no write: the writer went and checked, and its plan held.
	// That is the notice being acted on, not the writer walking away, so it
	// belongs with `repaired` rather than inflating the dismissed ratio.
	return touched ? { outcome: "repaired" } : { outcome: "dismissed" };
}
