import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { appendJsonlLines, pathExists, writeFileAtomic } from "../fs/atomic";
import { withPidLock } from "../fs/lockfile";
import type { WorkbenchPaths } from "../paths";
import {
	type EventFilter,
	type EventToAppend,
	THREAD_EVENT_SOURCE,
	validateThreadEvent,
	type WorkbenchEvent,
} from "../types/event";
import {
	cursorMatchesFile,
	type EventCursor,
	lineHash,
	readCursor,
	scanCursor,
} from "./event-cursor";

function newEventId(): string {
	// Eight random bytes are enough for a local append-only log and keep the
	// high-frequency interaction stream within its existing size budget.
	return `e-${randomBytes(8).toString("hex")}`;
}

/**
 * events.jsonl is append-only. A crash mid-append can leave a torn final
 * line; readers skip malformed lines instead of failing, so the log stays
 * usable and `doctor` can flag the corruption later.
 */
export function eventsApi(paths: WorkbenchPaths) {
	const cursorFile = `${paths.eventsFile}.cursor`;
	const lockFile = `${paths.eventsFile}.lock`;
	let localCursor: EventCursor | null = null;

	async function readAll(): Promise<WorkbenchEvent[]> {
		if (!(await pathExists(paths.eventsFile))) {
			return [];
		}
		const raw = await readFile(paths.eventsFile, "utf8");
		const events: WorkbenchEvent[] = [];
		let seq = 0;
		for (const line of raw.split("\n")) {
			if (!line.trim()) {
				continue;
			}
			seq += 1;
			try {
				const parsed = JSON.parse(line) as WorkbenchEvent;
				if (
					typeof parsed.type === "string" &&
					typeof parsed.timestamp === "string"
				) {
					// Legacy rows get deterministic identities from their immutable
					// physical position. New rows keep their stored identity/clock.
					events.push({
						...parsed,
						id: parsed.id ?? `legacy-${seq}`,
						eventSeq: Number.isSafeInteger(parsed.eventSeq)
							? parsed.eventSeq
							: seq,
						seq,
					});
				}
			} catch {
				// torn or garbage line: skip, keep reading
			}
		}
		return events;
	}

	/**
	 * Allocate sequences and write every line under one lock acquisition.
	 * Called with the append lock already held.
	 */
	async function appendLocked(
		batch: readonly EventToAppend[],
	): Promise<WorkbenchEvent[]> {
		// ponytail: one cursor rebuild on external edits, then O(1) appends;
		// a future high-volume store can move this counter to SQLite.
		// A cursor is a tiny shared counter. Read it while holding the
		// lock so separate processes cannot allocate the same sequence.
		const persisted = await readCursor(cursorFile);
		const cursor =
			persisted && (await cursorMatchesFile(paths.eventsFile, persisted))
				? persisted
				: localCursor &&
						(await cursorMatchesFile(paths.eventsFile, localCursor))
					? localCursor
					: await scanCursor(paths.eventsFile);
		const stored: WorkbenchEvent[] = [];
		const lines: string[] = [];
		let bytes = cursor.bytes;
		for (const [offset, event] of batch.entries()) {
			if (event.source === THREAD_EVENT_SOURCE) {
				validateThreadEvent(event.type, event.payload);
			}
			const entry: WorkbenchEvent = {
				...event,
				id: event.id ?? newEventId(),
				eventSeq: cursor.eventSeq + offset + 1,
			};
			const line = `${JSON.stringify(entry)}\n`;
			bytes += Buffer.byteLength(line, "utf8");
			stored.push(entry);
			lines.push(line);
		}
		// Validation runs over the whole batch before anything is written, so a
		// rejected member cannot leave its predecessors on disk.
		await appendJsonlLines(paths.eventsFile, stored);
		const last = stored.at(-1);
		const lastLine = lines.at(-1);
		if (!last || !lastLine) {
			return [];
		}
		const nextCursor: EventCursor = {
			eventSeq: last.eventSeq as number,
			physicalLines: cursor.physicalLines + stored.length,
			bytes,
			lastLineHash: lineHash(lastLine.trimEnd()),
			lastId: last.id,
		};
		// The append lock makes the counter update safe; atomic replacement
		// keeps a crash from leaving a half JSON cursor behind. One cursor
		// write per batch, not per line.
		await writeFileAtomic(cursorFile, JSON.stringify(nextCursor));
		localCursor = nextCursor;
		return stored.map((entry, offset) => ({
			...entry,
			seq: cursor.physicalLines + offset + 1,
		}));
	}

	return {
		async append(event: EventToAppend): Promise<WorkbenchEvent> {
			return withPidLock(lockFile, async () => {
				const [stored] = await appendLocked([event]);
				if (!stored) {
					throw new Error("事件追加未返回结果");
				}
				return stored;
			});
		},

		/**
		 * Append a causally related batch: one lock, one write, one cursor
		 * update, contiguous `eventSeq`. Empty batches are a no-op.
		 */
		async appendMany(
			batch: readonly EventToAppend[],
		): Promise<WorkbenchEvent[]> {
			if (batch.length === 0) {
				return [];
			}
			return withPidLock(lockFile, () => appendLocked(batch));
		},

		async appendThread(
			type: string,
			payload: Record<string, unknown>,
		): Promise<WorkbenchEvent> {
			validateThreadEvent(type, payload);
			return this.append({
				timestamp: new Date().toISOString(),
				source: THREAD_EVENT_SOURCE,
				type,
				payload,
			});
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
