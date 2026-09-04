import type { Blackboard } from "../blackboard";
import type { WorkbenchEvent } from "../types/event";
import { ChatThreads, type StoredMessage, type ThreadMeta } from "./threads";

const MINIMUM_HISTORY_DAYS = 14;
const SIBLING_WINDOW_MS = 30 * 60_000;

export interface ChatStats {
	threads: {
		total: number;
		withMessages: number;
		withFootprints: number;
		withResumeNotes: number;
		forked: number;
		resumeNoteCoverage: number | null;
		footprintCoverage: number | null;
	};
	forks: {
		total: number;
		perWeek: number | null;
		depth: {
			min: number;
			max: number;
			average: number;
		};
		families: {
			count: number;
			largestSize: number;
		};
	};
	observation: {
		startedAt: string | null;
		endedAt: string | null;
		days: number;
		minimumDays: number;
	};
	lifecycle: {
		switches: number;
		restores: number;
		resumeNotesConsumed: number;
		resumeActions: number;
		restoreFirstAction: {
			observed: number;
			known: number;
			unknown: number;
			byKind: Record<string, number>;
		};
	};
	siblingAlternation: {
		available: boolean;
		reason: string;
		families: number;
		alternatingFamilies: number;
		rate: number | null;
		transitions: number;
		windowMinutes: number;
	};
	dataQuality: {
		insufficientHistory: boolean;
		reasons: string[];
	};
}

function averageOf(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function eventPayload(event: WorkbenchEvent): Record<string, unknown> {
	return event.payload &&
		typeof event.payload === "object" &&
		!Array.isArray(event.payload)
		? (event.payload as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function eventOrder(event: WorkbenchEvent, index: number): number {
	return Number.isSafeInteger(event.eventSeq)
		? (event.eventSeq as number)
		: Number.isSafeInteger(event.seq)
			? (event.seq as number)
			: index;
}

function orderedEvents(events: WorkbenchEvent[]): WorkbenchEvent[] {
	return events
		.map((event, index) => ({ event, index }))
		.sort((a, b) => {
			const order = eventOrder(a.event, a.index) - eventOrder(b.event, b.index);
			return order || a.event.timestamp.localeCompare(b.event.timestamp);
		})
		.map(({ event }) => event);
}

function observationWindow(
	threads: ThreadMeta[],
	messagesByThread: Map<string, StoredMessage[]>,
	events: WorkbenchEvent[],
): {
	startedAt: string | null;
	endedAt: string | null;
	days: number;
	minimumDays: number;
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
		return {
			startedAt: null,
			endedAt: null,
			days: 0,
			minimumDays: MINIMUM_HISTORY_DAYS,
		};
	}
	const first = timestamps[0]!;
	const last = timestamps.at(-1)!;
	return {
		startedAt: first.value,
		endedAt: last.value,
		days: Math.max(0, (last.time - first.time) / 86_400_000),
		minimumDays: MINIMUM_HISTORY_DAYS,
	};
}

function familyRoot(id: string, parents: Map<string, string>): string {
	const seen = new Set<string>();
	let current = id;
	while (!seen.has(current)) {
		seen.add(current);
		const parent = parents.get(current);
		if (!parent) {
			return current;
		}
		current = parent;
	}
	return current;
}

function forkDepth(id: string, parents: Map<string, string>): number {
	let depth = 0;
	let current = id;
	const seen = new Set<string>();
	while (!seen.has(current)) {
		seen.add(current);
		const parent = parents.get(current);
		if (!parent) {
			break;
		}
		depth += 1;
		current = parent;
	}
	return depth;
}

function actionKind(action: string): string {
	const normalized = action.trim().toLowerCase().replace(/[_-]+/g, " ");
	if (normalized.includes("scroll")) {
		return "scroll-up";
	}
	if (normalized.includes("git log") || normalized === "gitlog") {
		return "git-log";
	}
	return normalized.slice(0, 80) || "unknown";
}

function restoreFirstActions(
	events: WorkbenchEvent[],
): ChatStats["lifecycle"]["restoreFirstAction"] {
	const ordered = orderedEvents(events);
	const byKind: Record<string, number> = {};
	let observed = 0;
	let restores = 0;
	for (let index = 0; index < ordered.length; index += 1) {
		const restored = ordered[index]!;
		if (restored.type !== "thread.restored") {
			continue;
		}
		restores += 1;
		const restoredPayload = eventPayload(restored);
		const threadId = stringValue(restoredPayload.threadId);
		if (!threadId) {
			continue;
		}
		let action: string | null = null;
		for (let next = index + 1; next < ordered.length; next += 1) {
			const candidate = ordered[next]!;
			const payload = eventPayload(candidate);
			if (
				candidate.type === "thread.switch" ||
				candidate.type === "thread.restored"
			) {
				// A later lane transition closes this restore window regardless of
				// which thread it names; actions after switching away cannot be
				// attributed to the restored lane.
				break;
			}
			if (
				candidate.type === "thread.resume_action" &&
				stringValue(payload.threadId) === threadId
			) {
				action = stringValue(payload.action);
				break;
			}
		}
		if (!action) {
			continue;
		}
		observed += 1;
		const kind = actionKind(action);
		byKind[kind] = (byKind[kind] ?? 0) + 1;
	}
	return {
		observed,
		known: observed,
		unknown: Math.max(0, restores - observed),
		byKind,
	};
}

function siblingAlternation(
	threads: ThreadMeta[],
	events: WorkbenchEvent[],
	parents: Map<string, string>,
): ChatStats["siblingAlternation"] {
	const groups = new Map<
		string,
		Array<{ from: string; to: string; at: number }>
	>();
	for (const event of orderedEvents(events)) {
		if (event.type !== "thread.switch") {
			continue;
		}
		const payload = eventPayload(event);
		const from = stringValue(payload.fromThreadId);
		const to = stringValue(payload.toThreadId) ?? stringValue(payload.threadId);
		if (!from || !to || from === to) {
			continue;
		}
		const parent = parents.get(from);
		if (!parent || parent !== parents.get(to)) {
			continue;
		}
		const at = Date.parse(event.timestamp);
		if (!Number.isFinite(at)) {
			continue;
		}
		const bucket = groups.get(parent) ?? [];
		bucket.push({ from, to, at });
		groups.set(parent, bucket);
	}
	let transitions = 0;
	let alternatingFamilies = 0;
	for (const sequence of groups.values()) {
		let familyTransitions = 0;
		for (let index = 1; index < sequence.length; index += 1) {
			const previous = sequence[index - 1]!;
			const current = sequence[index]!;
			if (
				current.at - previous.at <= SIBLING_WINDOW_MS &&
				(previous.to === current.from || previous.from === current.to)
			) {
				familyTransitions += 1;
			}
		}
		transitions += familyTransitions;
		if (familyTransitions >= 2) {
			alternatingFamilies += 1;
		}
	}
	const familyCount = new Set(
		threads
			.filter((thread) => thread.forkOf)
			.map((thread) => familyRoot(thread.id, parents)),
	).size;
	const candidateFamilies = groups.size;
	if (candidateFamilies === 0) {
		return {
			available: false,
			reason:
				familyCount === 0
					? "没有可比较的分叉家族"
					: "尚未观测到同一家族兄弟切换",
			families: familyCount,
			alternatingFamilies: 0,
			rate: null,
			transitions: 0,
			windowMinutes: 30,
		};
	}
	return {
		available: true,
		reason: "",
		families: candidateFamilies,
		alternatingFamilies,
		rate: Number((alternatingFamilies / candidateFamilies).toFixed(3)),
		transitions,
		windowMinutes: 30,
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
	const events = await bb.events.all();
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
	if (observation.days < 7) {
		reasons.push("observation window is shorter than 7 days");
	}
	if (observation.days < MINIMUM_HISTORY_DAYS) {
		reasons.push("observation window is shorter than 14 days");
	}
	if (withFootprints === 0) {
		reasons.push("no thread footprints");
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
		},
		siblingAlternation: alternation,
		dataQuality: {
			insufficientHistory:
				threads.length === 0 ||
				observation.days < MINIMUM_HISTORY_DAYS ||
				withFootprints === 0,
			reasons,
		},
	};
}
