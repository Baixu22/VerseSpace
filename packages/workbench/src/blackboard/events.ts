import { createHash, randomBytes } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
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

interface EventCursor {
	eventSeq: number;
	physicalLines: number;
	bytes: number;
	/** Fingerprint of the last non-empty line; detects raw/external appends. */
	lastLineHash?: string;
	lastId?: string;
}

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

	async function readCursor(): Promise<EventCursor | null> {
		try {
			const raw = await readFile(cursorFile, "utf8");
			const cursor = JSON.parse(raw) as EventCursor;
			if (
				Number.isSafeInteger(cursor.eventSeq) &&
				Number.isSafeInteger(cursor.physicalLines) &&
				Number.isSafeInteger(cursor.bytes) &&
				cursor.eventSeq >= 0 &&
				cursor.physicalLines >= 0 &&
				cursor.bytes >= 0
			) {
				return cursor;
			}
		} catch {
			// Missing/stale cursor: the next append rebuilds it once.
		}
		return null;
	}

	function lineHash(line: string): string {
		return createHash("sha256").update(line, "utf8").digest("hex");
	}

	/** Read just enough of the tail to verify the cursor's last line. */
	async function readTail(
		filePath: string,
		byteLimit = 64 * 1024,
	): Promise<{
		text: string;
		complete: boolean;
	}> {
		const handle = await open(filePath, "r");
		try {
			const info = await handle.stat();
			const length = Math.min(info.size, byteLimit);
			const buffer = Buffer.alloc(length);
			if (length > 0) {
				await handle.read(buffer, 0, length, info.size - length);
			}
			return {
				text: buffer.toString("utf8"),
				complete: length === info.size || buffer.includes(0x0a),
			};
		} finally {
			await handle.close();
		}
	}

	async function cursorMatchesFile(cursor: EventCursor): Promise<boolean> {
		try {
			const info = await stat(paths.eventsFile);
			if (info.size !== cursor.bytes) {
				return false;
			}
			if (cursor.physicalLines === 0) {
				return info.size === 0;
			}
			// Read only a small tail in the hot path. A changed final id or a torn
			// append invalidates the cursor and forces a full recovery scan.
			const tail = await readTail(paths.eventsFile);
			if (!tail.complete) {
				return false;
			}
			const lines = tail.text.split("\n").filter((line) => line.trim());
			const last = lines.at(-1);
			if (!last || cursor.lastLineHash !== lineHash(last)) {
				return false;
			}
			if (cursor.lastId === undefined) {
				return true;
			}
			try {
				return (JSON.parse(last) as { id?: string }).id === cursor.lastId;
			} catch {
				return false;
			}
		} catch {
			return false;
		}
	}

	async function scanCursor(): Promise<EventCursor> {
		let raw = "";
		try {
			raw = await readFile(paths.eventsFile, "utf8");
		} catch {
			return { eventSeq: 0, physicalLines: 0, bytes: 0 };
		}
		let physicalLines = 0;
		let eventSeq = 0;
		for (const line of raw.split("\n")) {
			if (!line.trim()) {
				continue;
			}
			physicalLines += 1;
			try {
				const parsed = JSON.parse(line) as WorkbenchEvent;
				const candidate = Number.isSafeInteger(parsed.eventSeq)
					? (parsed.eventSeq as number)
					: physicalLines;
				eventSeq = Math.max(eventSeq, candidate);
			} catch {
				// A torn line still occupies a physical position.
			}
		}
		return {
			eventSeq,
			physicalLines,
			bytes: Buffer.byteLength(raw, "utf8"),
			lastLineHash: raw
				.split("\n")
				.filter((line) => line.trim())
				.at(-1)
				? lineHash(
						raw
							.split("\n")
							.filter((line) => line.trim())
							.at(-1)!,
					)
				: undefined,
			lastId: (() => {
				const last = raw
					.split("\n")
					.filter((line) => line.trim())
					.at(-1);
				if (!last) {
					return undefined;
				}
				try {
					const parsed = JSON.parse(last) as { id?: unknown };
					return typeof parsed.id === "string" ? parsed.id : undefined;
				} catch {
					return undefined;
				}
			})(),
		};
	}

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
		const persisted = await readCursor();
		const cursor =
			persisted && (await cursorMatchesFile(persisted))
				? persisted
				: localCursor && (await cursorMatchesFile(localCursor))
					? localCursor
					: await scanCursor();
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
