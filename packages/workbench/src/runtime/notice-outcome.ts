import type { WorkbenchEvent } from "../types/event";
import { deliveryWindows } from "./notice-windows";
import { readSealRecord } from "./seal-counts";

/**
 * Notice outcome labelling (moat A's data source · TF-0148).
 *
 * A delivered `premise_notice` with no recorded consequence tells you nothing
 * about the notice's precision — "did that help?" becomes a matter of feeling,
 * and the two-week fit gate (TF-0136 判决二) has no numerator or denominator.
 *
 * So every delivery is labelled from what the log already holds: the writer's
 * later footprint rounds and any seal decision against it. Nothing new is
 * asked of the user and no new instrumentation is added (AC 4) — the label is
 * derived, which also means an old log can be relabelled when the rules
 * improve.
 *
 * The four states, and the one honest refusal:
 *
 * - `repaired`  the writer went back to an affected file after the notice —
 *               re-read then wrote it, or re-read and concluded no patch was
 *               needed. Both mean the notice was acted on, which is the number
 *               TF-0136 判决二 needs on the positive side;
 * - `ignored`   wrote an affected file without re-reading it — the notice was
 *               seen and overridden, which is the dangerous case and therefore
 *               never masked by a `repaired` on a sibling path;
 * - `sealed`    the seal stopped the write before the writer got there;
 * - `dismissed` the writer kept working but never went near those files;
 * - `unknown`   nothing can be concluded yet. Reads may be structurally
 *               unobservable (an HTTP provider has no tool channel — TF-0142),
 *               the writer may not have run again, or the notice's paths may
 *               not be recoverable from the log.
 */

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

const STALE = "premise_stale";
const FOOTPRINT = "footprint";

function payloadOf(event: WorkbenchEvent): Record<string, unknown> {
	return event.payload &&
		typeof event.payload === "object" &&
		!Array.isArray(event.payload)
		? (event.payload as Record<string, unknown>)
		: {};
}

function stringsOf(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

/** `{ path }` entries in a footprint or stale list, tolerant of junk. */
function pathsOf(value: unknown): string[] {
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

function orderOf(event: WorkbenchEvent, index: number): number {
	return Number.isSafeInteger(event.eventSeq)
		? (event.eventSeq as number)
		: Number.isSafeInteger(event.seq)
			? (event.seq as number)
			: index;
}

/** Log order, with the physical index as the last-resort tiebreak. */
function ordered(events: WorkbenchEvent[]): WorkbenchEvent[] {
	return events
		.map((event, index) => ({ event, index }))
		.sort(
			(a, b) =>
				orderOf(a.event, a.index) - orderOf(b.event, b.index) ||
				a.event.timestamp.localeCompare(b.event.timestamp),
		)
		.map(({ event }) => event);
}

/** Same containment rule the seal uses: a directory covers its files. */
function covers(target: string, claim: string): boolean {
	return (
		target === claim ||
		claim.startsWith(`${target}/`) ||
		target.startsWith(`${claim}/`)
	);
}

/**
 * Label every delivered notice from the log alone.
 *
 * Each delivery owns its provider-attempt window, ending when the next
 * successful notice attempt begins. Late acknowledgement must not discard
 * same-turn repairs or attribute the next turn's reaction twice.
 */
export function labelNoticeOutcomes(
	events: WorkbenchEvent[],
): LabeledDelivery[] {
	const timeline = ordered(events);
	// noticeId → affected paths, so the chat channel's delivery payload (which
	// carries ids but no paths) can still be resolved.
	const pathsByNotice = new Map<string, string[]>();
	for (const event of timeline) {
		if (event.type !== STALE) {
			continue;
		}
		const payload = payloadOf(event);
		const noticeId = payload.noticeId;
		if (typeof noticeId !== "string") {
			continue;
		}
		const known = pathsByNotice.get(noticeId) ?? [];
		pathsByNotice.set(noticeId, [
			...new Set([...known, ...pathsOf(payload.stale)]),
		]);
	}

	const labeled: LabeledDelivery[] = [];
	for (const window of deliveryWindows(timeline)) {
		const event = timeline[window.delivery]!;
		const payload = payloadOf(event);
		const writer = typeof payload.writer === "string" ? payload.writer : "";
		if (!writer) {
			continue; // a delivery with no writer cannot be attributed to anyone
		}
		const noticeIds = [
			...new Set([
				...(typeof payload.noticeId === "string" ? [payload.noticeId] : []),
				...stringsOf(payload.noticeIds),
			]),
		];
		const paths = [
			...new Set([
				...pathsOf(payload.stale),
				...noticeIds.flatMap((id) => pathsByNotice.get(id) ?? []),
			]),
		];
		const readObservability =
			payload.readObservability === "unobservable"
				? "unobservable"
				: "footprint";
		labeled.push({
			writer,
			noticeIds,
			paths,
			at: event.timestamp,
			readObservability,
			...judgeWindow(
				timeline.slice(window.start, window.end),
				writer,
				paths,
				readObservability,
			),
		});
	}
	return labeled;
}

/**
 * Decide one delivery's outcome from the events that followed it.
 *
 * Precedence is `sealed > ignored > repaired > dismissed > unknown`. `ignored`
 * outranks `repaired` deliberately: a writer that repaired one affected file
 * and blind-wrote another has still blind-written one, and that is the fact
 * worth counting (AC 2).
 */
function judgeWindow(
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

/** The human column of the calibration table (instrumented by TF-0139). */
export interface HumanNoticeActions {
	/** `thread.resume_note_consumed`: the card's note was actually read. */
	notesConsumed: number;
	/** `thread.resume_action` with action `resume_card_dismissed`. */
	dismissed: number;
	/** All `thread.resume_action` observations, dismissals included. */
	actions: number;
	byAction: Record<string, number>;
}

export interface NoticeOutcomeTotals {
	agent: Record<NoticeOutcome, number> & {
		delivered: number;
		/** Unknowns split by why, so "unknown" is never a shrug. */
		unknownBy: Record<UnknownReason, number>;
	};
	human: HumanNoticeActions;
	/**
	 * Observations in the calibration table: one per labelled delivery plus one
	 * per recorded human action. This is the number the 30-day moat check reads
	 * (`校准表行数 ≥ 50`), so it counts observations, not distinct writers.
	 */
	rows: number;
	/**
	 * ignored / delivered, or null with no deliveries. 判决二 fails above 0.1.
	 */
	ignoredRatio: number | null;
	/** dismissed / delivered, or null with no deliveries. 判决二 fails above 0.5. */
	dismissedRatio: number | null;
}

function ratio(part: number, whole: number): number | null {
	return whole > 0 ? Number((part / whole).toFixed(3)) : null;
}

export function foldNoticeOutcomes(
	events: WorkbenchEvent[],
): NoticeOutcomeTotals {
	const agent = {
		delivered: 0,
		repaired: 0,
		ignored: 0,
		sealed: 0,
		dismissed: 0,
		unknown: 0,
		unknownBy: {
			unobservable: 0,
			"no-later-activity": 0,
			"unresolved-paths": 0,
		} as Record<UnknownReason, number>,
	};
	for (const delivery of labelNoticeOutcomes(events)) {
		agent.delivered += 1;
		agent[delivery.outcome] += 1;
		if (delivery.outcome === "unknown" && delivery.unknownReason) {
			agent.unknownBy[delivery.unknownReason] += 1;
		}
	}

	const human: HumanNoticeActions = {
		notesConsumed: 0,
		dismissed: 0,
		actions: 0,
		byAction: {},
	};
	for (const event of events) {
		if (event.type === "thread.resume_note_consumed") {
			human.notesConsumed += 1;
			continue;
		}
		if (event.type !== "thread.resume_action") {
			continue;
		}
		human.actions += 1;
		const action = payloadOf(event).action;
		const key = typeof action === "string" && action ? action : "unknown";
		human.byAction[key] = (human.byAction[key] ?? 0) + 1;
		if (key === "resume_card_dismissed") {
			human.dismissed += 1;
		}
	}

	return {
		agent,
		human,
		rows: agent.delivered + human.actions + human.notesConsumed,
		ignoredRatio: ratio(agent.ignored, agent.delivered),
		dismissedRatio: ratio(agent.dismissed, agent.delivered),
	};
}
