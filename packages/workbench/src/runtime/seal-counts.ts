import type { WorkbenchEvent } from "../types/event";

/**
 * Seal observability (R2 · TF-0134).
 *
 * The seal is the only place the runtime interrupts a writer, which makes it
 * the one decision that must never be invisible: before this, a block left no
 * trace anywhere, so "was that seal correct?" had no answer and the 30-day
 * moat number (`至少一次真实且正确的 seal.decided: block`) had no source.
 *
 * Every decision is recorded, including the ones that let the write through.
 * A log that only holds refusals cannot tell you the seal's precision.
 */

export const SEAL_EVENT = "seal.decided" as const;

export type SealMode = "block" | "warn" | "off";

/** What actually happened to the write. */
export type SealDecision = "block" | "warn" | "pass";

/**
 * Why the seal fired. `stale_premise` is the ledger's own thesis — the write
 * was built on something that moved. `readonly_area` is a project-declared
 * `protection.readonlyAreas` refusal. They are different facts, and the moat
 * number only counts the first, so the record must say which one it was.
 */
export type SealKind = "stale_premise" | "readonly_area";

export interface SealDecisionRecord {
	/** Writer id when the host supplied one, else null (hook payloads may not). */
	writer: string | null;
	/** Project-relative target of the intercepted write. */
	path: string;
	decision: SealDecision;
	/**
	 * Which predicate fired, or null when nothing matched (a plain pass).
	 * Records written before readonly areas were enforced have no `kind`; they
	 * can only have been stale-premise hits, so they are read back as such.
	 */
	kind: SealKind | null;
	/**
	 * Whether the predicate matched at all. `pass` + `hit: true` is the honest
	 * shape of "the seal saw a stale premise and mode was off" — the write went
	 * through, but the observation is still on the record.
	 */
	hit: boolean;
	/** Paths of the stale claims the target overlapped. Paths, not bodies. */
	matchedDeclarations: string[];
	/** Configured mode. */
	mode: SealMode;
	/** Mode actually applied, after the consecutive-block downgrade. */
	effectiveMode: SealMode;
	/** True when the streak limit forced `effectiveMode` below `mode`. */
	downgraded: boolean;
}

export interface SealTotals {
	decisions: number;
	/** Every refusal, whatever the reason. `readonlyBlocks ⊆ blocked`. */
	blocked: number;
	/**
	 * Refusals whose reason was a stale premise. This is the number the moat
	 * judgment reads — a protected-path refusal is not evidence that the
	 * premise ledger works.
	 */
	premiseBlocked: number;
	/** Refusals caused by `protection.readonlyAreas`. */
	readonlyBlocks: number;
	warned: number;
	/** Decisions that let the write through with no predicate match. */
	passed: number;
	/** Stale-premise matches, whatever the mode did about them. */
	hits: number;
	/** Hits that were let through because the seal was warn or off. */
	hitsAllowed: number;
	/** Decisions taken under a downgraded (auto-warn) seal. */
	downgraded: number;
	byMode: Record<SealMode, number>;
	lastDecisionAt: string | null;
}

function isDecision(value: unknown): value is SealDecision {
	return value === "block" || value === "warn" || value === "pass";
}

function isMode(value: unknown): value is SealMode {
	return value === "block" || value === "warn" || value === "off";
}

function isKind(value: unknown): value is SealKind {
	return value === "stale_premise" || value === "readonly_area";
}

/** Read one `seal.decided` payload back, tolerating older or partial shapes. */
export function readSealRecord(
	event: WorkbenchEvent,
): SealDecisionRecord | null {
	if (event.type !== SEAL_EVENT) {
		return null;
	}
	const payload =
		event.payload &&
		typeof event.payload === "object" &&
		!Array.isArray(event.payload)
			? (event.payload as Record<string, unknown>)
			: null;
	if (!payload || !isDecision(payload.decision)) {
		return null;
	}
	const matched = Array.isArray(payload.matchedDeclarations)
		? payload.matchedDeclarations.filter(
				(item): item is string => typeof item === "string",
			)
		: [];
	const mode = isMode(payload.mode) ? payload.mode : "block";
	const hit =
		typeof payload.hit === "boolean"
			? payload.hit
			: // Older records had no `hit`; a non-empty match set implies one.
				matched.length > 0 || payload.decision !== "pass";
	return {
		writer: typeof payload.writer === "string" ? payload.writer : null,
		path: typeof payload.path === "string" ? payload.path : "",
		decision: payload.decision,
		kind: isKind(payload.kind) ? payload.kind : hit ? "stale_premise" : null,
		hit,
		matchedDeclarations: matched,
		mode,
		effectiveMode: isMode(payload.effectiveMode) ? payload.effectiveMode : mode,
		downgraded: payload.downgraded === true,
	};
}

/**
 * Consecutive unresolved hits against `writer`, newest first, stopping at the
 * first decision where the predicate did not match.
 *
 * It counts *hits*, not blocks, and that distinction is the whole design. If
 * the streak reset on the first non-block decision, the auto-downgrade would
 * reset itself the moment it fired: N blocks, one warn, N blocks, one warn —
 * a 1-in-N relief valve rather than a downgrade. Counting hits means the
 * downgraded state persists until the writer either clears the stale premise
 * (no more match) or moves on to a clean file.
 *
 * Protected-path refusals are skipped rather than counted: they are not
 * premise hits, and they must not be able to push a writer into (or out of)
 * the stale-premise downgrade.
 *
 * The streak is per writer: one writer repeatedly hitting the same seal is a
 * fact about that writer's situation, not about the project.
 */
export function consecutiveHitStreak(
	events: WorkbenchEvent[],
	writer: string | null,
): number {
	let streak = 0;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const record = readSealRecord(events[index]!);
		if (!record || record.writer !== writer) {
			continue;
		}
		if (record.kind === "readonly_area") {
			continue;
		}
		if (!record.hit) {
			break;
		}
		streak += 1;
	}
	return streak;
}

/** Fold every recorded decision into the counts `workbench stats` reports. */
export function foldSealDecisions(events: WorkbenchEvent[]): SealTotals {
	const totals: SealTotals = {
		decisions: 0,
		blocked: 0,
		premiseBlocked: 0,
		readonlyBlocks: 0,
		warned: 0,
		passed: 0,
		hits: 0,
		hitsAllowed: 0,
		downgraded: 0,
		byMode: { block: 0, warn: 0, off: 0 },
		lastDecisionAt: null,
	};
	for (const event of events) {
		const record = readSealRecord(event);
		if (!record) {
			continue;
		}
		totals.decisions += 1;
		totals.byMode[record.effectiveMode] += 1;
		if (record.downgraded) {
			totals.downgraded += 1;
		}
		if (record.kind === "readonly_area") {
			totals.readonlyBlocks += 1;
		}
		if (record.hit && record.kind === "stale_premise") {
			totals.hits += 1;
			if (record.decision !== "block") {
				totals.hitsAllowed += 1;
			}
		}
		if (record.decision === "block") {
			totals.blocked += 1;
			if (record.kind === "stale_premise") {
				totals.premiseBlocked += 1;
			}
		} else if (record.decision === "warn") {
			totals.warned += 1;
		} else if (!record.hit) {
			totals.passed += 1;
		}
		totals.lastDecisionAt = event.timestamp;
	}
	return totals;
}
