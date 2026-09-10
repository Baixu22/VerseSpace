import type { WorkbenchEvent } from "../types/event";
import { eventPayload, orderedEvents, stringValue } from "./stats-events";
import type { ChatStats } from "./stats-types";

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

export function restoreFirstActions(
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
