import { z } from "zod";
import type { WorkbenchEvent } from "../types/event";
import type { StoredMessage } from "./threads";

/** Optional fields keep older clients readable without guessing card exposure. */
export const restoreObservationSchema = z.object({
	fromThreadId: z.string().min(1).nullable().optional(),
	resumeCardVisible: z.boolean().optional(),
	lastMessageId: z.string().min(1).nullable().optional(),
});

export type RestoreObservation = z.infer<typeof restoreObservationSchema>;

interface TimingGroup {
	samples: number;
	medianMs: number | null;
}

export interface RestoreTimingStats {
	windowDays: number;
	withCard: TimingGroup;
	withoutCard: TimingGroup;
	unknownCard: TimingGroup;
	/** No next user message in this visit, or missing/invalid timing evidence. */
	incomplete: number;
	medianChangeRatio: number | null;
	exceeds20Percent: boolean | null;
}

function summarize(values: number[]): TimingGroup {
	values.sort((a, b) => a - b);
	const middle = Math.floor(values.length / 2);
	return {
		samples: values.length,
		medianMs:
			values.length === 0
				? null
				: values.length % 2
					? values[middle]!
					: (values[middle - 1]! + values[middle]!) / 2,
	};
}

/**
 * TF-0126: join each restore to its first new user message, before leaving.
 * `ordered` uses the event log's causal order, not potentially drifting clocks.
 * The seven-day comparison is descriptive; it never changes card behavior.
 */
export function foldRestoreTimings(
	ordered: WorkbenchEvent[],
	messagesByThread: Map<string, StoredMessage[]>,
	now = Date.now(),
): RestoreTimingStats {
	const windowDays = 7;
	const since = now - windowDays * 86_400_000;
	const groups = {
		withCard: [] as number[],
		withoutCard: [] as number[],
		unknownCard: [] as number[],
	};
	let incomplete = 0;
	let pending: WorkbenchEvent | undefined;

	const finishVisit = (endAt?: number) => {
		if (!pending) return;
		const restored = pending;
		pending = undefined;
		const start = Date.parse(restored.timestamp);
		if (Number.isFinite(start) && (start < since || start > now)) return;
		const payload = restored.payload as
			| (RestoreObservation & { threadId?: string })
			| null;
		const messages = messagesByThread.get(payload?.threadId ?? "") ?? [];
		const baseline =
			payload?.lastMessageId === null
				? -1
				: messages.findIndex(
						(message) => message.id === payload?.lastMessageId,
					);
		// Without the loaded transcript boundary, a delayed observation could
		// mistake the second prompt for the first. Deleted history stays unknown.
		if (
			!Number.isFinite(start) ||
			payload?.lastMessageId === undefined ||
			(payload.lastMessageId !== null && baseline < 0)
		) {
			incomplete += 1;
			return;
		}
		const message = messages
			.slice(baseline + 1)
			.find((item) => item.role === "user");
		const at = Date.parse(message?.at ?? "");
		if (
			!Number.isFinite(at) ||
			at < start ||
			at > now ||
			(endAt !== undefined && (!Number.isFinite(endAt) || at >= endAt))
		) {
			incomplete += 1;
			return;
		}
		const group =
			payload.resumeCardVisible === true
				? "withCard"
				: payload.resumeCardVisible === false
					? "withoutCard"
					: "unknownCard";
		groups[group].push(at - start);
	};

	for (const event of ordered) {
		if (event.type === "thread.switch" || event.type === "thread.restored") {
			finishVisit(Date.parse(event.timestamp));
			if (event.type === "thread.restored") pending = event;
		} else if (
			event.type === "thread.left" &&
			(event.payload as { threadId?: string } | null)?.threadId ===
				(pending?.payload as { threadId?: string } | null)?.threadId
		) {
			finishVisit(Date.parse(event.timestamp));
		}
	}
	finishVisit();
	const withCard = summarize(groups.withCard);
	const withoutCard = summarize(groups.withoutCard);
	const medianChangeRatio =
		withCard.medianMs !== null &&
		withoutCard.medianMs !== null &&
		withoutCard.medianMs > 0
			? (withCard.medianMs - withoutCard.medianMs) / withoutCard.medianMs
			: null;
	return {
		windowDays,
		withCard,
		withoutCard,
		unknownCard: summarize(groups.unknownCard),
		incomplete,
		medianChangeRatio,
		exceeds20Percent:
			medianChangeRatio === null ? null : medianChangeRatio > 0.2,
	};
}
