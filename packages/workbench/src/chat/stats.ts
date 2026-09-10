import type { Blackboard } from "../blackboard";
import { foldLandmarkReviews } from "../interactions/review";
import { currentLandmarkAcceptance } from "../interactions/review-stats";
import { foldNoticeOutcomes } from "../runtime/notice-outcome";
import {
	foldPremisePasses,
	foldRecentPremisePasses,
} from "../runtime/premise-counts";
import { foldSealDecisions } from "../runtime/seal-counts";
import { sealReviewTotals } from "../runtime/seal-review";
import type { WorkbenchEvent } from "../types/event";
import { restoreFirstActions } from "./restore-actions";
import { foldRestoreTimings } from "./restore-timing";
import { orderedEvents } from "./stats-events";
import { familyRoot, forkDepth, siblingAlternation } from "./stats-forks";
import type { ChatStats } from "./stats-types";
import { ChatThreads, type StoredMessage, type ThreadMeta } from "./threads";

export type { ChatStats } from "./stats-types";

function averageOf(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function observationWindow(
	threads: ThreadMeta[],
	messagesByThread: Map<string, StoredMessage[]>,
	events: WorkbenchEvent[],
): {
	startedAt: string | null;
	endedAt: string | null;
	days: number;
} {
	const timestamps = [
		...threads.map((thread) => thread.createdAt),
		...threads.flatMap((thread) =>
			(messagesByThread.get(thread.id) ?? []).map((message) => message.at),
		),
		...events.map((event) => event.timestamp),
	]
		.map((value) => ({ value, time: Date.parse(value) }))
		.filter(({ time }) => Number.isFinite(time))
		.sort((a, b) => a.time - b.time);
	if (timestamps.length === 0) {
		return { startedAt: null, endedAt: null, days: 0 };
	}
	const first = timestamps[0]!;
	const last = timestamps.at(-1)!;
	return {
		startedAt: first.value,
		endedAt: last.value,
		days: Math.max(0, (last.time - first.time) / 86_400_000),
	};
}

export async function collectChatStats(bb: Blackboard): Promise<ChatStats> {
	const chat = new ChatThreads(bb);
	const threads = await chat.list();
	const messagesByThread = new Map<string, StoredMessage[]>();
	const footprintCounts = new Map<string, number>();
	for (const thread of threads) {
		messagesByThread.set(thread.id, await chat.messages(thread.id));
		footprintCounts.set(
			thread.id,
			(await bb.sessions.footprint(thread.id)).length,
		);
	}
	const [events, writers] = await Promise.all([
		bb.events.all(),
		bb.sessions.list(),
	]);
	const forkedThreads = threads.filter((thread) =>
		Boolean(thread.forkOf?.sourceThreadId),
	);
	const parents = new Map(
		threads.flatMap((thread) =>
			thread.forkOf?.sourceThreadId
				? [[thread.id, thread.forkOf.sourceThreadId] as const]
				: [],
		),
	);
	const forkDepths = forkedThreads.map((thread) =>
		forkDepth(thread.id, parents),
	);
	const familySizes = new Map<string, number>();
	for (const thread of threads) {
		const root = familyRoot(thread.id, parents);
		familySizes.set(root, (familySizes.get(root) ?? 0) + 1);
	}
	const withMessages = [...messagesByThread.values()].filter(
		(messages) => messages.length > 0,
	).length;
	const withFootprints = [...footprintCounts.values()].filter(
		(count) => count > 0,
	).length;
	const withResumeNotes = threads.filter(
		(thread) => thread.resumeNote !== undefined,
	).length;
	const observation = observationWindow(threads, messagesByThread, events);
	const firstActions = restoreFirstActions(events);
	const alternation = siblingAlternation(threads, events, parents);
	const switches = events.filter(
		(event) => event.type === "thread.switch",
	).length;
	const restores = events.filter(
		(event) => event.type === "thread.restored",
	).length;
	const reasons: string[] = [];
	if (threads.length === 0) {
		reasons.push("no threads");
	}
	// 2026-09-06 重设计（用户决策）：工程探索阶段不用日历硬堵——样本量说了算。
	// 旧的「窗口短于 7/14 天」两条日历判据删除，代之以恢复周期这类行为样本。
	if (withFootprints === 0) {
		reasons.push("no thread footprints");
	}
	if (restores === 0) {
		reasons.push("no restore cycle observed");
	}
	if (switches === 0) {
		reasons.push("no thread.switch observations");
	}

	return {
		threads: {
			total: threads.length,
			withMessages,
			withFootprints,
			withResumeNotes,
			forked: forkedThreads.length,
			resumeNoteCoverage:
				threads.length > 0 ? withResumeNotes / threads.length : null,
			footprintCoverage:
				threads.length > 0 ? withFootprints / threads.length : null,
		},
		forks: {
			total: forkedThreads.length,
			perWeek:
				observation.days >= 7
					? Number((forkedThreads.length / (observation.days / 7)).toFixed(2))
					: null,
			depth: {
				min: forkDepths.length > 0 ? Math.min(...forkDepths) : 0,
				max: forkDepths.length > 0 ? Math.max(...forkDepths) : 0,
				average: Number(averageOf(forkDepths).toFixed(2)),
			},
			families: {
				count: [...familySizes.values()].filter((size) => size > 1).length,
				largestSize:
					familySizes.size > 0 ? Math.max(...familySizes.values()) : 0,
			},
		},
		observation,
		lifecycle: {
			switches,
			restores,
			resumeNotesConsumed: events.filter(
				(event) => event.type === "thread.resume_note_consumed",
			).length,
			resumeActions: events.filter(
				(event) => event.type === "thread.resume_action",
			).length,
			restoreFirstAction: firstActions,
			restoreToMessage: foldRestoreTimings(
				orderedEvents(events),
				messagesByThread,
			),
		},
		siblingAlternation: alternation,
		premises: foldPremisePasses(events),
		premisesRecent: foldRecentPremisePasses(events),
		seal: {
			...foldSealDecisions(events),
			reviews: sealReviewTotals(events),
		},
		noticeOutcomes: foldNoticeOutcomes(events),
		landmarkReviews: {
			...foldLandmarkReviews(events),
			current: currentLandmarkAcceptance(
				orderedEvents(events),
				writers.map((writer) => writer.id),
			),
		},
		dataQuality: {
			insufficientHistory:
				threads.length === 0 || withFootprints === 0 || restores === 0,
			reasons,
		},
	};
}
