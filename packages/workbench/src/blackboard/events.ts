import { readFile } from "node:fs/promises";
import { appendJsonlLine, pathExists } from "../fs/atomic";
import type { WorkbenchPaths } from "../paths";
import type { EventFilter, WorkbenchEvent } from "../types/event";

/**
 * events.jsonl is append-only. A crash mid-append can leave a torn final
 * line; readers skip malformed lines instead of failing, so the log stays
 * usable and `doctor` can flag the corruption later.
 */
export function eventsApi(paths: WorkbenchPaths) {
	async function readAll(): Promise<WorkbenchEvent[]> {
		if (!(await pathExists(paths.eventsFile))) {
			return [];
		}
		const raw = await readFile(paths.eventsFile, "utf8");
		const events: WorkbenchEvent[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) {
				continue;
			}
			try {
				const parsed = JSON.parse(line) as WorkbenchEvent;
				if (
					typeof parsed.type === "string" &&
					typeof parsed.timestamp === "string"
				) {
					events.push(parsed);
				}
			} catch {
				// torn or garbage line: skip, keep reading
			}
		}
		return events;
	}

	return {
		async append(event: WorkbenchEvent): Promise<void> {
			await appendJsonlLine(paths.eventsFile, event);
		},

		async all(): Promise<WorkbenchEvent[]> {
			return readAll();
		},

		async tail(n: number): Promise<WorkbenchEvent[]> {
			const events = await readAll();
			return events.slice(-n);
		},

		async query(filter: EventFilter): Promise<WorkbenchEvent[]> {
			const events = await readAll();
			const matched = events.filter(
				(event) =>
					(filter.type === undefined || event.type === filter.type) &&
					(filter.source === undefined || event.source === filter.source),
			);
			return filter.limit === undefined
				? matched
				: matched.slice(-filter.limit);
		},
	};
}
