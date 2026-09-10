import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonlLine, pathExists, safeReaddir } from "../fs/atomic";
import { withPidLock } from "../fs/lockfile";
import { deriveInteractions } from "../interactions/derive";
import {
	INTERACTIONS_SOURCE,
	INTERACTIONS_TYPE,
	type InteractionEvent,
} from "../interactions/types";
import type { WorkbenchPaths } from "../paths";
import type { WorkbenchEvent } from "../types/event";
import { type Writer, writerSchema } from "../types/session";
import { readYamlFile, writeYamlFile } from "../yamlio";

/**
 * The sessions region (R1): every writer that can touch the repository —
 * agent sessions, the human's editor, git, CI — registers here and appends
 * a footprint. This is the precondition for premise invalidation (R2):
 * the runtime cannot notify a writer that is not in its model, and it
 * cannot compare premises it never recorded.
 *
 * Two stores, one truth:
 * - `sessions/<writer>/footprint.jsonl` — the writer's raw activity log;
 * - the shared `events.jsonl` — one PROV-shaped `footprint` event per
 *   activity, so cross-writer views are a fold over a single log.
 * Each local footprint line keeps its own monotonic `seq` for read-set replay;
 * `eventId`/`eventSeq` point at the shared event clock for cross-writer joins.
 */

/**
 * R2 predicate layer 2 (TF-0075): the line range that actually entered the
 * writer's context, not the whole file. A 2000-line file the agent read 20
 * lines of is not invalidated by an edit on line 3.
 */
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

export function sessionsApi(paths: WorkbenchPaths, events: SessionsEvents) {
	function dirFor(id: string): string {
		return join(paths.sessions, sanitizeWriterId(id));
	}
	function writerFileFor(id: string): string {
		return join(dirFor(id), "writer.yaml");
	}
	function footprintFileFor(id: string): string {
		return join(dirFor(id), "footprint.jsonl");
	}

	async function readFootprintLines(id: string): Promise<FootprintLine[]> {
		const file = footprintFileFor(id);
		if (!(await pathExists(file))) {
			return [];
		}
		const raw = await readFile(file, "utf8");
		const lines: FootprintLine[] = [];
		let seq = 0;
		for (const line of raw.split("\n")) {
			if (!line.trim()) {
				continue;
			}
			seq += 1;
			try {
				const parsed = JSON.parse(line) as FootprintEntry;
				if (typeof parsed.activity === "string") {
					lines.push({
						...parsed,
						used: parsed.used ?? [],
						generated: parsed.generated ?? [],
						seq,
					});
				}
			} catch {
				// torn final line: skip, the log stays readable
			}
		}
		return lines;
	}

	async function touch(writerId: string): Promise<void> {
		const file = writerFileFor(writerId);
		if (!(await pathExists(file))) {
			return;
		}
		const writer = await readYamlFile(file, writerSchema);
		writer.lastActiveAt = new Date().toISOString();
		await writeYamlFile(file, writerSchema, writer);
	}

	return {
		/** Idempotent: re-registering a known writer refreshes its activity. */
		async register(
			id: string,
			kind: Writer["kind"],
			label = "",
			extra: { task?: string; workspot?: string } = {},
		): Promise<Writer> {
			const file = writerFileFor(id);
			const now = new Date().toISOString();
			let writer: Writer;
			if (await pathExists(file)) {
				writer = await readYamlFile(file, writerSchema);
				writer.kind = kind;
				if (label) {
					writer.label = label;
				}
				if (extra.task) {
					writer.task = extra.task;
				}
				if (extra.workspot) {
					writer.workspot = extra.workspot;
				}
				writer.status = "active";
				writer.lastActiveAt = now;
			} else {
				writer = writerSchema.parse({
					id,
					kind,
					label,
					status: "active",
					task: extra.task,
					workspot: extra.workspot,
					startedAt: now,
					lastActiveAt: now,
				});
			}
			await writeYamlFile(file, writerSchema, writer);
			return writer;
		},

		async setStatus(id: string, status: Writer["status"]): Promise<void> {
			const file = writerFileFor(id);
			if (!(await pathExists(file))) {
				return;
			}
			const writer = await readYamlFile(file, writerSchema);
			writer.status = status;
			writer.lastActiveAt = new Date().toISOString();
			await writeYamlFile(file, writerSchema, writer);
		},

		async get(id: string): Promise<Writer | null> {
			const file = writerFileFor(id);
			if (!(await pathExists(file))) {
				return null;
			}
			return readYamlFile(file, writerSchema);
		},

		async list(): Promise<Writer[]> {
			const names = await safeReaddir(paths.sessions);
			const writers = await Promise.all(
				names.map((name) =>
					readYamlFile(
						join(paths.sessions, name, "writer.yaml"),
						writerSchema,
					).catch(() => null),
				),
			);
			return writers
				.filter((writer): writer is Writer => writer !== null)
				.sort((a, b) => a.id.localeCompare(b.id));
		},

		async recordActivity(
			writerId: string,
			entry: Omit<FootprintEntry, "timestamp">,
		): Promise<void> {
			// A writer can emit tool results concurrently (for example, a streamed
			// sub-agent and its parent). Serialize its local mirror so the per-writer
			// line clock and the shared event join key cannot cross.
			await withPidLock(`${dirFor(writerId)}.footprint.lock`, async () => {
				const eventId = entry.eventId ?? `fp-${randomBytes(8).toString("hex")}`;
				const timestamp = new Date().toISOString();
				const full: FootprintEntry = { ...entry, eventId, timestamp };
				// Inherited context is a provider fact, not a fresh human interaction;
				// keep it out of DOI/attention projections while retaining the footprint.
				// L1 (TF-0087): interaction projections share the event clock but are
				// still separate world facts.
				const interactions =
					full.facets?.inherited === true
						? []
						: deriveInteractions(full, writerId);
				// Append the shared facts first: if the process dies, an orphaned
				// shared fact is preferable to a local footprint that has no causal
				// identity. One lock and one cursor write for the whole activity —
				// per-line appends cost ~4 lock round-trips per tool call (TF-0143).
				const [mirrored] = await events.appendMany([
					{
						id: eventId,
						timestamp,
						source: "sessions",
						type: "footprint",
						payload: { writer: writerId, ...entry, eventId },
					},
					...interactions.map((interaction) => ({
						timestamp: interaction.time,
						source: INTERACTIONS_SOURCE,
						type: INTERACTIONS_TYPE,
						payload: interaction as InteractionEvent,
					})),
				]);
				// Keep single lines well under the 4KB atomic-append budget.
				await appendJsonlLine(footprintFileFor(writerId), {
					...full,
					...(mirrored ? { eventSeq: mirrored.eventSeq } : {}),
				} satisfies FootprintEntry);
				await touch(writerId);
			});
		},

		async footprint(writerId: string): Promise<FootprintLine[]> {
			return readFootprintLines(writerId);
		},

		/**
		 * Fold the writer's footprint into a read-set view: for every path,
		 * the version the writer last observed. `uptoSeq` rebuilds the view
		 * as of any earlier moment (footprints are only ever appended).
		 */
		async readSetView(
			writerId: string,
			uptoSeq?: number,
		): Promise<{
			reads: Map<string, FootprintUsed & { seq: number }>;
			writes: Array<FootprintUsed & { seq: number; ts: string }>;
		}> {
			const reads = new Map<string, FootprintUsed & { seq: number }>();
			const writes: Array<FootprintUsed & { seq: number; ts: string }> = [];
			for (const line of await readFootprintLines(writerId)) {
				if (uptoSeq !== undefined && line.seq > uptoSeq) {
					break;
				}
				for (const used of line.used) {
					// A content-reading tool observed the body, even if it never
					// edited the file. Replay whole reads as 1..EOF so layer 3 cannot
					// mistake code review for a signature-only dependency. Deriving
					// this from existing facets also repairs old logs without a migration;
					// the ordinary span claim survives real fork inheritance unchanged.
					const span =
						used.span ??
						(["Read", "Bash", "PowerShell"].includes(String(line.facets?.tool))
							? { start: 1, end: Number.MAX_SAFE_INTEGER }
							: undefined);
					reads.set(used.path, {
						...used,
						...(span ? { span } : {}),
						seq: line.seq,
					});
				}
				for (const gen of line.generated) {
					writes.push({ ...gen, seq: line.seq, ts: line.timestamp });
					// the writer's own write supersedes what it read before
					reads.set(gen.path, { ...gen, seq: line.seq });
				}
			}
			return { reads, writes };
		},

		/**
		 * Paths a writer of one of `kinds` (default: agent) claimed as generated
		 * within the window — the watcher's attribution filter: file changes
		 * matching a fresh agent claim belong to that agent, everything else
		 * is the human.
		 *
		 * Accepts several kinds because git is now a first-class writer
		 * (TF-0150): a `git pull` lands in the working tree as ordinary file
		 * changes, and without git in this filter the post-merge hook's claim is
		 * immediately shadowed by a human claim on the same paths.
		 */
		async recentGeneratedPaths(
			windowMs: number,
			kinds: Writer["kind"] | Writer["kind"][] = "agent",
		): Promise<Set<string>> {
			const wanted = new Set(Array.isArray(kinds) ? kinds : [kinds]);
			const cutoff = Date.now() - windowMs;
			const claimed = new Set<string>();
			for (const name of await safeReaddir(paths.sessions)) {
				const writerFile = join(paths.sessions, name, "writer.yaml");
				if (!(await pathExists(writerFile))) {
					continue;
				}
				try {
					const writer = await readYamlFile(writerFile, writerSchema);
					if (!wanted.has(writer.kind)) {
						continue;
					}
					const lines = await readFootprintLines(writer.id);
					for (let i = lines.length - 1; i >= 0; i -= 1) {
						const line = lines[i]!;
						const ts = Date.parse(line.timestamp);
						if (Number.isFinite(ts) && ts < cutoff) {
							break; // footprints are time-ordered; older lines lose
						}
						for (const gen of line.generated) {
							claimed.add(gen.path);
						}
					}
				} catch {}
			}
			return claimed;
		},
	};
}

/** Writer ids become directory names: keep them filesystem-safe. */
export function sanitizeWriterId(id: string): string {
	return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Canonical location for read-time spool snapshots. */
export function writerSpoolDir(
	paths: WorkbenchPaths,
	writerId: string,
): string {
	return join(paths.sessions, sanitizeWriterId(writerId), "spool");
}

/**
 * Pre-R2 builds accidentally wrote chat spools below `.workbench/sessions`.
 * Keep this read-only fallback so an existing workspace does not lose its
 * diff evidence while all new writes use `writerSpoolDir`.
 */
export function legacyWriterSpoolDir(
	paths: WorkbenchPaths,
	writerId: string,
): string {
	return join(paths.root, "sessions", sanitizeWriterId(writerId), "spool");
}
