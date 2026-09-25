import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BlackboardDataError } from "../errors";
import { pathExists, safeReaddir } from "../fs/atomic";
import { newId } from "../ids";
import type { WorkbenchPaths } from "../paths";
import {
	type Conflict,
	conflictsFileSchema,
	type QueueEntry,
	queueEntrySchema,
	queueFileSchema,
} from "../types/state";
import { type Workspot, workspotSchema } from "../types/workspot";
import { readYamlFile, writeYamlFile } from "../yamlio";

export function stateApi(paths: WorkbenchPaths) {
	const workspotFile = (id: string) => join(paths.workspots, `${id}.yaml`);
	const queueEntryFile = (goalId: string) =>
		join(paths.queue, `${goalId}.yaml`);

	async function loadConflicts() {
		if (!(await pathExists(paths.conflicts))) {
			return conflictsFileSchema.parse({});
		}
		return readYamlFile(paths.conflicts, conflictsFileSchema);
	}

	/**
	 * Pre-0.3 workspaces kept the whole queue in one queue.yaml; move it to
	 * one file per entry on first touch. Concurrent migrators converge: entry
	 * creation is O_EXCL-idempotent and the legacy remove is idempotent.
	 */
	async function migrateLegacyQueue(): Promise<void> {
		const legacy = join(paths.state, "queue.yaml");
		if (!(await pathExists(legacy))) {
			return;
		}
		const file = await readYamlFile(legacy, queueFileSchema);
		await mkdir(paths.queue, { recursive: true });
		for (const [index, goalId] of file.queue.entries()) {
			await writeYamlFile(queueEntryFile(goalId), queueEntrySchema, {
				goalId,
				seq: index,
			});
		}
		await rm(legacy, { force: true });
	}

	async function listEntries(): Promise<QueueEntry[]> {
		const names = await safeReaddir(paths.queue);
		const entries = await Promise.all(
			names
				.filter((name) => name.endsWith(".yaml"))
				.map(async (name) => {
					try {
						return await readYamlFile(
							join(paths.queue, name),
							queueEntrySchema,
						);
					} catch (error) {
						// TF-0269 (OPEN-6)：一条读不出来的队列条目以前让队列无声地少一项。
						// 两个后果都不该由「没看见」承担：那个目标从此不会被派发，
						// 而 enqueue 的 seq 是拿这份列表的长度算的——顺序也跟着变。
						console.error(
							`[state] 队列条目 ${name} 无法读取（已从队列中省略，该目标不会被派发）:`,
							error,
						);
						return null;
					}
				}),
		);
		return entries
			.filter((entry): entry is QueueEntry => entry !== null)
			.sort((a, b) =>
				a.seq === b.seq ? a.goalId.localeCompare(b.goalId) : a.seq - b.seq,
			);
	}

	const workspots = {
		async get(id: string): Promise<Workspot | null> {
			try {
				return await readYamlFile(workspotFile(id), workspotSchema);
			} catch (error) {
				if (
					error instanceof BlackboardDataError &&
					error.message === "file not found"
				) {
					return null;
				}
				throw error;
			}
		},

		async save(workspot: Workspot): Promise<void> {
			await writeYamlFile(workspotFile(workspot.id), workspotSchema, workspot);
		},

		async list(): Promise<Workspot[]> {
			const entries = await safeReaddir(paths.workspots);
			const ids = entries
				.filter((name) => name.endsWith(".yaml"))
				.map((name) => name.slice(0, -".yaml".length));
			const spots = await Promise.all(ids.map((id) => workspots.get(id)));
			return spots
				.filter((spot): spot is Workspot => spot !== null)
				.sort((a, b) => a.id.localeCompare(b.id));
		},
	};

	const queue = {
		async get(): Promise<string[]> {
			await migrateLegacyQueue();
			return (await listEntries()).map((entry) => entry.goalId);
		},

		/** Idempotent: enqueueing an already-queued goal keeps its position. */
		async enqueue(goalId: string): Promise<string[]> {
			await migrateLegacyQueue();
			await mkdir(paths.queue, { recursive: true });
			// one file per entry, named by the goal id: concurrent enqueues of
			// the same goal target the same file (idempotent), and different
			// goals write different files — no update can be lost
			if (!(await pathExists(queueEntryFile(goalId)))) {
				const seq = (await listEntries()).length;
				await writeYamlFile(queueEntryFile(goalId), queueEntrySchema, {
					goalId,
					seq,
				});
			}
			return (await listEntries()).map((entry) => entry.goalId);
		},

		async dequeue(goalId: string): Promise<string[]> {
			await migrateLegacyQueue();
			await rm(queueEntryFile(goalId), { force: true });
			return (await listEntries()).map((entry) => entry.goalId);
		},
	};

	const conflicts = {
		async list(): Promise<Conflict[]> {
			return (await loadConflicts()).conflicts;
		},

		async add(kind: string, detail: string): Promise<Conflict> {
			const file = await loadConflicts();
			const conflict = {
				id: newId("c"),
				kind,
				detail,
				createdAt: new Date().toISOString(),
			};
			file.conflicts.push(conflict);
			await writeYamlFile(paths.conflicts, conflictsFileSchema, file);
			return conflict;
		},
	};

	return { workspots, queue, conflicts };
}
