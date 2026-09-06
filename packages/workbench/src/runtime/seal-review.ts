import type { Blackboard } from "../blackboard";
import type { WorkbenchEvent } from "../types/event";
import { readSealRecord } from "./seal-counts";

export interface SealReview {
	sealEventId: string;
	reviewEventId: string;
	writer: string | null;
	correct: boolean;
	reason: string;
}

/** A block is evidence of a refusal, never evidence that the refusal was right. */
export function foldSealReviews(events: WorkbenchEvent[]): SealReview[] {
	const decisions = new Map<string, ReturnType<typeof readSealRecord>>();
	const reviews = new Map<string, SealReview>();
	for (const event of events) {
		const seal = readSealRecord(event);
		if (seal && event.id) decisions.set(event.id, seal);
		if (event.type !== "seal.reviewed" || event.source !== "human" || !event.id)
			continue;
		const payload = event.payload as Partial<SealReview> | null;
		if (
			!payload ||
			typeof payload.sealEventId !== "string" ||
			typeof payload.correct !== "boolean" ||
			typeof payload.reason !== "string" ||
			!payload.reason.trim()
		)
			continue;
		const decision = decisions.get(payload.sealEventId);
		if (decision?.decision !== "block") continue;
		reviews.set(payload.sealEventId, {
			sealEventId: payload.sealEventId,
			reviewEventId: event.id,
			writer: decision.writer,
			correct: payload.correct,
			reason: payload.reason,
		});
	}
	return [...reviews.values()];
}

/** Human assessment is appended with its source id; a correction adds a new row. */
export async function reviewSeal(
	bb: Blackboard,
	sealEventId: string,
	correct: boolean,
	reason: string,
) {
	if (!reason.trim()) throw new Error("封印复核必须说明依据");
	const target = (await bb.events.query({ type: "seal.decided" })).find(
		(event) => event.id === sealEventId,
	);
	if (!target || readSealRecord(target)?.decision !== "block")
		throw new Error("未找到对应的封印阻断事件");
	return bb.events.append({
		timestamp: new Date().toISOString(),
		source: "human",
		type: "seal.reviewed",
		payload: { sealEventId, correct, reason: reason.trim() },
	});
}

/** `stats.seal.reviews` 的聚合形状：护城河 C「且事后判定为正确」的那条腿。 */
export interface SealReviewTotals {
	total: number;
	correct: number;
	incorrect: number;
}

export function sealReviewTotals(events: WorkbenchEvent[]): SealReviewTotals {
	const rows = foldSealReviews(events);
	return {
		total: rows.length,
		correct: rows.filter((row) => row.correct).length,
		incorrect: rows.filter((row) => !row.correct).length,
	};
}
