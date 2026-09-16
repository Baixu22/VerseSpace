import type { WorkbenchEvent } from "../types/event";

export interface ReadSpan {
	/** 1-based, inclusive. `end` may exceed the file length (read to EOF). */
	start: number;
	end: number;
	/**
	 * Hash of just this range as observed. Absent while the claim is still
	 * being captured (the channel knows the range, not its content yet);
	 * null when the range could not be read.
	 */
	hash?: string | null;
}

export interface FootprintUsed {
	path: string;
	/** Content hash at the time the writer observed the file. */
	version?: string | null;
	/** File size when the content was too large to hash. */
	size?: number;
	/** R2 predicate layer 1: durable claims never enter premise checking. */
	durability?: "volatile" | "durable";
	/** Spooled read-time content (≤64KB files) — the diff side of a notice. */
	spool?: string;
	/** R2 predicate layer 2: only this range has to still hold. */
	span?: ReadSpan;
}

export interface FootprintEntry {
	timestamp: string;
	/** Stable join key shared with the mirrored events.jsonl footprint row. */
	eventId?: string;
	/** Global event clock observed when the mirror was appended. */
	eventSeq?: number;
	/** One tool call / batched editor change / ref update. */
	activity: string;
	/** The writer (or subagent via parent_tool_use_id) that acted. */
	agent: string;
	used: FootprintUsed[];
	generated: FootprintUsed[];
	/** Open facets: tool name, command line, ref name, capture channel. */
	facets?: Record<string, unknown>;
}

export interface FootprintLine extends FootprintEntry {
	/** Line number in footprint.jsonl (1-based) — the monotonic clock. */
	seq: number;
}

export interface SessionsEvents {
	append(event: {
		timestamp: string;
		source: string;
		type: string;
		payload: unknown;
		id?: string;
	}): Promise<WorkbenchEvent>;
	appendMany(
		batch: ReadonlyArray<{
			timestamp: string;
			source: string;
			type: string;
			payload: unknown;
			id?: string;
		}>,
	): Promise<WorkbenchEvent[]>;
}
