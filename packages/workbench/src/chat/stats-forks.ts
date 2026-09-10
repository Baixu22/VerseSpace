import type { WorkbenchEvent } from "../types/event";
import { eventPayload, orderedEvents, stringValue } from "./stats-events";
import type { ChatStats } from "./stats-types";
import type { ThreadMeta } from "./threads";

const SIBLING_WINDOW_MS = 30 * 60_000;

export function familyRoot(id: string, parents: Map<string, string>): string {
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

export function forkDepth(id: string, parents: Map<string, string>): number {
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

export function siblingAlternation(
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
	const alternatingRoots = new Set<string>();
	for (const [parent, sequence] of groups) {
		let previousTransitionStart: number | undefined;
		for (let index = 1; index < sequence.length; index += 1) {
			const previous = sequence[index - 1]!;
			const current = sequence[index]!;
			const elapsed = current.at - previous.at;
			if (
				elapsed >= 0 &&
				elapsed <= SIBLING_WINDOW_MS &&
				previous.to === current.from
			) {
				transitions += 1;
				// Both transitions, including their first switch, must fit one window.
				if (
					previousTransitionStart !== undefined &&
					current.at - previousTransitionStart <= SIBLING_WINDOW_MS
				) {
					alternatingRoots.add(familyRoot(parent, parents));
				}
				previousTransitionStart = previous.at;
			} else {
				previousTransitionStart = undefined;
			}
		}
	}
	const familyCount = new Set(
		threads
			.filter((thread) => thread.forkOf)
			.map((thread) => familyRoot(thread.id, parents)),
	).size;
	if (groups.size === 0) {
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
		families: familyCount,
		alternatingFamilies: alternatingRoots.size,
		// Unvisited families stay in the denominator; nested sibling groups
		// are still part of one root family.
		rate: Number((alternatingRoots.size / familyCount).toFixed(3)),
		transitions,
		windowMinutes: 30,
	};
}
