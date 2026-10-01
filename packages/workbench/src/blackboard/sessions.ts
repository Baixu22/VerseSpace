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
import { type Writer, writerSchema } from "../types/session";
import { readYamlFile, writeYamlFile } from "../yamlio";
import { sanitizeWriterId } from "./session-paths";
import type {
	FootprintEntry,
	FootprintLine,
	SessionsEvents,
} from "./session-types";
import { foldReadSet, type ReadSetView } from "./session-view";

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
				names.map(async (name) => {
					try {
						return await readYamlFile(
							join(paths.sessions, name, "writer.yaml"),
							writerSchema,
						);
					} catch (err) {
						// 一个读不出来的写者会静默从名册里消失：写集重叠判定随之少一个
						// 来源，而界面上看不出区别。与 recentGeneratedPaths 同一条口径——
						// 降级可以，静默不行（TF-0261 sweep，2026-09-25）。
						console.error(
							`[sessions] list: 写者 ${name} 无法读取（已从名册中省略）:`,
							err,
						);
						return null;
					}
				}),
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
		 * the last observation (`reads`) and versioned ranges (`readFragments`).
		 * Validity checks and inheritance consume the ranges. `uptoSeq` rebuilds the view
		 * as of any earlier moment (footprints are only ever appended).
		 */
		async readSetView(
			writerId: string,
			uptoSeq?: number,
		): Promise<ReadSetView> {
			return foldReadSet(await readFootprintLines(writerId), uptoSeq);
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
				} catch (err) {
					// 单个写者读失败会让它的 claim 从集合里消失，watcher 随即把
					// 该写者的改动归给「人」——归属错误必须可见，不能静默降级
					// （2026-09-13 收尾 §4.5 复核判定）。
					console.error(
						`[sessions] recentGeneratedPaths: 写者 ${name} 的足迹读取失败，本次归属判定将缺少它的 claim:`,
						err,
					);
				}
			}
			return claimed;
		},
	};
}

export {
	legacyWriterSpoolDir,
	sanitizeWriterId,
	writerSpoolDir,
} from "./session-paths";
export type {
	FootprintEntry,
	FootprintLine,
	FootprintUsed,
	ReadSpan,
	SessionsEvents,
} from "./session-types";
