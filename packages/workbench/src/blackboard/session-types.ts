import { z } from "zod";
import type { WorkbenchEvent } from "../types/event";

const contentDigest = z.string().regex(/^[a-f0-9]{64}$/);
const selectorSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("file") }),
	z
		.strictObject({
			kind: z.literal("lines"),
			start: z.number().int().positive(),
			end: z.number().int().positive(),
		})
		.refine((range) => range.end >= range.start),
]);

/** Returned text, normalized content and sampled file versions are different objects. */
export const inputObservationSchema = z.discriminatedUnion("source", [
	z.strictObject({
		schemaVersion: z.literal(1),
		source: z.literal("tool-observed"),
		returnedHash: contentDigest,
		contentHash: contentDigest,
		selector: selectorSchema,
		normalization: z.literal("utf8-lines-v1"),
		sample: z
			.strictObject({
				version: contentDigest,
				contentHash: contentDigest,
				stable: z.boolean(),
			})
			.optional(),
	}),
	z.strictObject({
		schemaVersion: z.literal(1),
		source: z.literal("fs-sample"),
		sample: z.strictObject({ version: contentDigest, stable: z.boolean() }),
	}),
	z.strictObject({
		schemaVersion: z.literal(1),
		source: z.literal("declared"),
		contentHash: contentDigest,
	}),
	z.strictObject({
		schemaVersion: z.literal(1),
		source: z.literal("unknown"),
		reason: z.string().min(1),
	}),
]);
export type InputObservation = z.infer<typeof inputObservationSchema>;

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
	/** Sampled full-file hash; never by itself proof of returned tool content. */
	version?: string | null;
	/** File size when the content was too large to hash. */
	size?: number;
	/** R2 predicate layer 1: durable claims never enter premise checking. */
	durability?: "volatile" | "durable";
	/** Spooled read-time content (≤64KB files) — the diff side of a notice. */
	spool?: string;
	/** R2 predicate layer 2: only this range has to still hold. */
	span?: ReadSpan;
	/** Optional for old logs. Missing/invalid evidence remains unknown, never backfilled. */
	observation?: InputObservation;
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
