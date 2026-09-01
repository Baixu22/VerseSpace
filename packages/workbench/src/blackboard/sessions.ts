import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appendJsonlLine, pathExists, safeReaddir } from "../fs/atomic";
import { deriveInteractions } from "../interactions/derive";
import {
	INTERACTIONS_SOURCE,
	INTERACTIONS_TYPE,
	type InteractionEvent,
} from "../interactions/types";
import type { WorkbenchPaths } from "../paths";
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
 * `seq` is the line number in the respective append-only file: monotonic
 * by construction, no write-time coordination, and the same clock L1's
 * DOI decay will use.
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
	}): Promise<void>;
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
			const full: FootprintEntry = {
				...entry,
				timestamp: new Date().toISOString(),
			};
			// keep single lines well under the 4KB atomic-append budget
			await appendJsonlLine(footprintFileFor(writerId), full);
			await events.append({
				timestamp: full.timestamp,
				source: "sessions",
				type: "footprint",
				payload: { writer: writerId, ...entry },
			});
			// L1 (TF-0087): 与足迹共用同一条 events.jsonl 与同一个 seq 时钟，
			// 把同一活动的 PROV 派生成交互事件（used→selection, generated→edit）。
			for (const interaction of deriveInteractions(full, writerId)) {
				await events.append({
					timestamp: interaction.time,
					source: INTERACTIONS_SOURCE,
					type: INTERACTIONS_TYPE,
					payload: interaction as InteractionEvent,
				});
			}
			await touch(writerId);
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
					reads.set(used.path, { ...used, seq: line.seq });
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
		 * Paths a writer of `kind` (default: agent) claimed as generated
		 * within the window — the watcher's attribution filter: file changes
		 * matching a fresh agent claim belong to that agent, everything else
		 * is the human.
		 */
		async recentGeneratedPaths(
			windowMs: number,
			kind: Writer["kind"] = "agent",
		): Promise<Set<string>> {
			const cutoff = Date.now() - windowMs;
			const claimed = new Set<string>();
			for (const name of await safeReaddir(paths.sessions)) {
				const writerFile = join(paths.sessions, name, "writer.yaml");
				if (!(await pathExists(writerFile))) {
					continue;
				}
				try {
					const writer = await readYamlFile(writerFile, writerSchema);
					if (writer.kind !== kind) {
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
