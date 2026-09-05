/**
 * Dual-channel restore card (TF-0128).
 *
 * Narrative is a reminder; facts are the disagreement. Conflict never rewrites
 * narrative text -- it only annotates. A card with no note and no stale facts
 * does not render. One dismiss suppresses the next automatic inject.
 */

import type { ReadSetDiff, ReadSetFact } from "../runtime/read-set-diff";
import type { ResumeBeat, ResumeNote } from "./resume";

export const FACTS_PREVIEW_COUNT = 3;

export type ConflictRule =
	| "R1"
	| "R2"
	| "R3"
	| "R4"
	| "R5"
	| "R6"
	| "R7"
	| "R8"
	| "R9";

export interface ClaimObservation {
	path: string;
	claimedVersion?: string | null;
	preWriteVersion?: string | null;
	movedTo?: string | null;
}

export interface RepoFact {
	path: string;
	currentVersion: string | null;
	writerId?: string | null;
	writerLabel?: string | null;
	refs: string[];
}

export interface ConflictAnnotation {
	rule: ConflictRule;
	label: string;
}

export interface NarrativeRow {
	kind: "doing" | "decided" | "next";
	text: string;
	refs: string[];
	annotation?: ConflictAnnotation;
}

export interface FactRow {
	path: string;
	summary: string;
	refs: string[];
	observedVersion?: string;
	currentVersion?: string | null;
	writerId?: string | null;
	writerLabel?: string | null;
	diff?: string;
	annotation?: ConflictAnnotation;
	source: "read-set" | "shifted";
}

export interface ResumeCardView {
	narrative: NarrativeRow[];
	facts: FactRow[];
	dismissed: boolean;
	/** Auto-inject into the restore surface. False after one dismiss. */
	inject: boolean;
}

export interface LifecycleEventLike {
	type: string;
	id?: string;
	eventSeq?: number;
	payload: unknown;
}

const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.\w+/g;

export function extractPaths(text: string): string[] {
	const found = text.match(PATH_RE) ?? [];
	return [...new Set(found.map((path) => path.replace(/\\/g, "/")))];
}

function payloadOf(event: LifecycleEventLike): Record<string, unknown> | null {
	const payload = event.payload;
	return payload && typeof payload === "object" && !Array.isArray(payload)
		? (payload as Record<string, unknown>)
		: null;
}

function beatRefs(beat: ResumeBeat): string[] {
	return (beat.refs ?? []).filter((ref) => ref.trim().length > 0);
}

function reminderRefs(beat: ResumeBeat): string[] {
	const refs = beatRefs(beat);
	if (refs.length > 0) {
		return refs;
	}
	// Pre-TF-0128 notes have no evidence pointers. Keep doing/decided/next as
	// reminders; shifted still moves to the facts section and follows R9.
	if (beat.kind === "shifted") {
		return [];
	}
	return [`legacy:${beat.kind}`];
}

function toRepoFact(fact: ReadSetFact): RepoFact {
	return {
		path: fact.path.replace(/\\/g, "/"),
		currentVersion: fact.currentVersion,
		writerId: fact.writerId,
		writerLabel: fact.writerLabel,
		refs: fact.refs,
	};
}

function factByPath(
	facts: ReadSetFact[],
	path: string,
): ReadSetFact | undefined {
	const normalized = path.replace(/\\/g, "/");
	return facts.find((fact) => fact.path.replace(/\\/g, "/") === normalized);
}

/**
 * Conflict rules R1-R5: (claimed write, current repo fact) -> annotation.
 * A null label means the original text stays as-is (R1).
 */
export function annotateClaim(
	claim: ClaimObservation,
	fact: RepoFact | null,
): {
	rule: Extract<ConflictRule, "R1" | "R2" | "R3" | "R4" | "R5">;
	label: string | null;
} {
	if (claim.movedTo && claim.movedTo !== claim.path) {
		return { rule: "R5", label: `现在在 ${claim.movedTo}` };
	}
	if (fact && fact.currentVersion == null) {
		return { rule: "R4", label: "已被删除" };
	}
	const current = fact?.currentVersion ?? null;
	if (!fact || (claim.claimedVersion && current === claim.claimedVersion)) {
		return { rule: "R1", label: null };
	}
	if (
		claim.preWriteVersion &&
		current === claim.preWriteVersion &&
		current !== (claim.claimedVersion ?? current)
	) {
		const writer = fact.writerLabel || fact.writerId;
		return {
			rule: "R3",
			label: writer ? `已被回滚（写者 ${writer}）` : "已被回滚",
		};
	}
	const writer = fact?.writerLabel || fact?.writerId;
	return {
		rule: "R2",
		label: writer ? `之后被 ${writer} 改写` : "之后被改写",
	};
}

function annotationFrom(
	result: ReturnType<typeof annotateClaim>,
): ConflictAnnotation | undefined {
	return result.label ? { rule: result.rule, label: result.label } : undefined;
}

function factRowFromReadSet(
	fact: ReadSetFact,
	annotation?: ConflictAnnotation,
): FactRow | null {
	if (fact.refs.length === 0) {
		return null;
	}
	const writer = fact.writerLabel || fact.writerId || "未知";
	const currentLabel =
		fact.currentVersion == null
			? "文件不存在"
			: fact.currentVersion.slice(0, 10);
	return {
		path: fact.path,
		summary: `${fact.observedVersion.slice(0, 10)} → ${currentLabel} · ${writer}`,
		refs: fact.refs,
		observedVersion: fact.observedVersion,
		currentVersion: fact.currentVersion,
		writerId: fact.writerId,
		writerLabel: fact.writerLabel,
		...(fact.diff ? { diff: fact.diff } : {}),
		...(annotation ? { annotation } : {}),
		source: "read-set",
	};
}

function isStaleConflict(path: string, stale: ReadSetFact[]): boolean {
	const fact = factByPath(stale, path);
	if (!fact) {
		return false;
	}
	const result = annotateClaim({ path }, toRepoFact(fact));
	return (
		result.rule === "R2" ||
		result.rule === "R3" ||
		result.rule === "R4" ||
		result.rule === "R5"
	);
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

export function buildResumeCard(input: {
	note: ResumeNote | null;
	diff: ReadSetDiff | null;
	dismissed?: boolean;
	promotionReverted?: boolean;
}): ResumeCardView | null {
	const dismissed = Boolean(input.dismissed);
	const stale = input.diff?.stale ?? [];
	const facts: FactRow[] = [];
	const usedPaths = new Set<string>();
	const shiftedText = (input.note?.beats ?? [])
		.filter((beat) => beat.kind === "shifted")
		.map((beat) => beat.text)
		.join(" ");
	const shiftedPaths = new Set(extractPaths(shiftedText));

	for (const fact of stale) {
		const path = fact.path.replace(/\\/g, "/");
		const claim = shiftedPaths.has(path) ? { path } : undefined;
		const annotated = claim
			? annotationFrom(annotateClaim(claim, toRepoFact(fact)))
			: undefined;
		const row = factRowFromReadSet(fact, annotated);
		if (!row) {
			continue;
		}
		facts.push(row);
		usedPaths.add(path);
	}

	if (input.note) {
		for (const beat of input.note.beats) {
			if (beat.kind !== "shifted") {
				continue;
			}
			const refs = reminderRefs(beat);
			if (refs.length === 0) {
				continue;
			}
			const paths = extractPaths(beat.text);
			if (paths.length === 0) {
				facts.push({
					path: beat.text,
					summary: beat.text,
					refs,
					source: "shifted",
				});
				continue;
			}
			for (const path of paths) {
				if (usedPaths.has(path)) {
					continue;
				}
				const fact = factByPath(stale, path);
				const annotated = annotationFrom(
					annotateClaim({ path }, fact ? toRepoFact(fact) : null),
				);
				facts.push({
					path,
					summary: beat.text,
					refs,
					source: "shifted",
					...(annotated ? { annotation: annotated } : {}),
				});
				usedPaths.add(path);
			}
		}
	}

	const narrative: NarrativeRow[] = [];
	if (input.note) {
		for (const beat of input.note.beats) {
			if (beat.kind === "shifted") {
				continue;
			}
			const refs = reminderRefs(beat);
			if (refs.length === 0) {
				continue;
			}
			if (beat.kind === "decided") {
				narrative.push({
					kind: "decided",
					text: beat.text,
					refs,
					...(input.promotionReverted
						? { annotation: { rule: "R7", label: "已撤销" } }
						: {}),
				});
				continue;
			}
			if (beat.kind === "next") {
				const hit = extractPaths(beat.text).some((path) =>
					isStaleConflict(path, stale),
				);
				narrative.push({
					kind: "next",
					text: beat.text,
					refs,
					...(hit ? { annotation: { rule: "R8", label: "其前提已变" } } : {}),
				});
				continue;
			}
			if (beat.kind === "doing") {
				narrative.push({ kind: "doing", text: beat.text, refs });
			}
		}
	}

	if (narrative.length === 0 && facts.length === 0) {
		return null;
	}
	return {
		narrative,
		facts,
		dismissed,
		inject: !dismissed,
	};
}

export function shouldInjectResumeCard(card: ResumeCardView | null): boolean {
	return Boolean(card?.inject);
}
