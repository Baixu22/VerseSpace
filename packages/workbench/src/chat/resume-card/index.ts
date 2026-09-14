/** Dual-channel restore card: narrative reminders and evidence-backed facts. */
import type { ReadSetDiff, ReadSetFact } from "../../runtime/read-set-diff";
import type { ResumeBeat, ResumeNote } from "../resume";
import { coverageOf } from "./coverage";
import {
	type ClaimObservation,
	type ConflictAnnotation,
	type ConflictRule,
	FACTS_PREVIEW_COUNT,
	type FactRow,
	type NarrativeRow,
	type RepoFact,
	type ResumeCardView,
} from "./types";

export { FORBIDDEN_CARD_PHRASES } from "./coverage";
export { isResumeCardDismissed, type LifecycleEventLike } from "./dismissal";
export * from "./types";

const PATH_RE = /(?:[\w.-]+\/)+[\w.-]+\.\w+/g;

export function extractPaths(text: string): string[] {
	const found = text.match(PATH_RE) ?? [];
	return [...new Set(found.map((path) => path.replace(/\\/g, "/")))];
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

export function buildResumeCard(input: {
	note: ResumeNote | null;
	diff: ReadSetDiff | null;
	dismissed?: boolean;
	promotionReverted?: boolean;
	branchFacts?: FactRow[];
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

	facts.push(...(input.branchFacts ?? []).filter((row) => row.refs.length > 0));

	if (narrative.length === 0 && facts.length === 0) {
		// TF-0128 still holds: no note and no disagreement renders nothing. The
		// coverage line is the facts section's header, not a reason to render a
		// card that has no content.
		return null;
	}
	return {
		coverage: coverageOf(input.diff, stale.length),
		narrative,
		facts,
		dismissed,
		inject: !dismissed,
		// 预览条数随载荷下发：客户端直接读它，不再自带一份同值常量
		// （2026-09-13 收尾 §5.6——单一来源）。
		factsPreviewCount: FACTS_PREVIEW_COUNT,
	};
}
