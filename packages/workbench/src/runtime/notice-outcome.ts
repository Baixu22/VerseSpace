import type { WorkbenchEvent } from "../types/event";
import type {
	LabeledDelivery,
	NoticeOutcome,
	UnknownReason,
} from "./notice-window";
import {
	judgeWindow,
	ordered,
	pathsOf,
	payloadOf,
	STALE,
	stringsOf,
} from "./notice-window";
import { deliveryWindows } from "./notice-windows";

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

export function ratio(part: number, whole: number): number | null {
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

export type {
	LabeledDelivery,
	NoticeOutcome,
	UnknownReason,
} from "./notice-window";
