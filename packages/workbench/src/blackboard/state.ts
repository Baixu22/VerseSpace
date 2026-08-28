import { join } from "node:path";
import { BlackboardDataError } from "../errors";
import { pathExists, safeReaddir } from "../fs/atomic";
import { newId } from "../ids";
import type { WorkbenchPaths } from "../paths";
import {
	type Conflict,
	conflictsFileSchema,
	queueFileSchema,
} from "../types/state";
import { type Workspot, workspotSchema } from "../types/workspot";
import { readYamlFile, writeYamlFile } from "../yamlio";

export function stateApi(paths: WorkbenchPaths) {
	const workspotFile = (id: string) => join(paths.workspots, `${id}.yaml`);

	async function loadQueue() {
		if (!(await pathExists(paths.queue))) {
			return queueFileSchema.parse({});
		}
		return readYamlFile(paths.queue, queueFileSchema);
	}

	async function loadConflicts() {
		if (!(await pathExists(paths.conflicts))) {
			return conflictsFileSchema.parse({});
		}
		return readYamlFile(paths.conflicts, conflictsFileSchema);
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
			return (await loadQueue()).queue;
		},

		/** Idempotent: enqueueing an already-queued goal is a no-op. */
		async enqueue(goalId: string): Promise<string[]> {
			const file = await loadQueue();
			if (!file.queue.includes(goalId)) {
				file.queue.push(goalId);
				await writeYamlFile(paths.queue, queueFileSchema, file);
			}
			return file.queue;
		},

		async dequeue(goalId: string): Promise<string[]> {
			const file = await loadQueue();
			const next = file.queue.filter((id) => id !== goalId);
			if (next.length !== file.queue.length) {
				await writeYamlFile(paths.queue, queueFileSchema, { queue: next });
			}
			return next;
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
