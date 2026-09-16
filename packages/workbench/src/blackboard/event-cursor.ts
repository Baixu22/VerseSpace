import { createHash } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";

import type { WorkbenchEvent } from "../types/event";

export interface EventCursor {
	eventSeq: number;
	physicalLines: number;
	bytes: number;
	/** Fingerprint of the last non-empty line; detects raw/external appends. */
	lastLineHash?: string;
	lastId?: string;
}

export async function readCursor(
	cursorFile: string,
): Promise<EventCursor | null> {
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

export function lineHash(line: string): string {
	return createHash("sha256").update(line, "utf8").digest("hex");
}

/** Read just enough of the tail to verify the cursor's last line. */
export async function readTail(
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

export async function cursorMatchesFile(
	eventFile: string,
	cursor: EventCursor,
): Promise<boolean> {
	try {
		const info = await stat(eventFile);
		if (info.size !== cursor.bytes) {
			return false;
		}
		if (cursor.physicalLines === 0) {
			return info.size === 0;
		}
		// Read only a small tail in the hot path. A changed final id or a torn
		// append invalidates the cursor and forces a full recovery scan.
		const tail = await readTail(eventFile);
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

export async function scanCursor(eventFile: string): Promise<EventCursor> {
	let raw = "";
	try {
		raw = await readFile(eventFile, "utf8");
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
