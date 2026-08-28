import { join } from "node:path";
import { BlackboardDataError } from "../errors";
import { appendJsonlLine, pathExists, safeReaddir } from "../fs/atomic";
import type { WorkbenchPaths } from "../paths";
import {
	type Checkpoint,
	type CheckpointLifecycle,
	checkpointSchema,
} from "../types/checkpoint";
import type { ZoneCheckpoints } from "../types/snapshot";
import { readYamlFile, writeYamlFile } from "../yamlio";

export const CHECKPOINT_ZONES = ["staging", "verified", "failed"] as const;
export type Zone = (typeof CHECKPOINT_ZONES)[number];

/** Which lifecycle values legitimately live in which zone. */
export const ZONE_LIFECYCLES: Record<Zone, CheckpointLifecycle[]> = {
	staging: ["draft", "pending", "awaiting_review"],
	verified: ["verified", "applied"],
	failed: ["failed", "rejected"],
};

export function checkpointsApi(paths: WorkbenchPaths) {
	const zoneDir = (zone: Zone) => join(paths.checkpoints, zone);
	const fileFor = (zone: Zone, id: string) => join(zoneDir(zone), `${id}.yaml`);

	async function scanZone(zone: Zone): Promise<Checkpoint[]> {
		const entries = await safeReaddir(zoneDir(zone));
		const ids = entries
			.filter((name) => name.endsWith(".yaml"))
			.map((name) => name.slice(0, -".yaml".length));
		const checkpoints = await Promise.all(
			ids.map(async (id) => {
				try {
					return await readYamlFile(fileFor(zone, id), checkpointSchema);
				} catch (error) {
					if (
						error instanceof BlackboardDataError &&
						error.message === "file not found"
					) {
						return null;
					}
					throw error;
				}
			}),
		);
		return checkpoints
			.filter((cp): cp is Checkpoint => cp !== null)
			.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	}

	return {
		async save(checkpoint: Checkpoint, zone: Zone): Promise<void> {
			await writeYamlFile(
				fileFor(zone, checkpoint.id),
				checkpointSchema,
				checkpoint,
			);
		},

		scanZone,

		async scanAll(): Promise<ZoneCheckpoints> {
			const [staging, verified, failed] = await Promise.all([
				scanZone("staging"),
				scanZone("verified"),
				scanZone("failed"),
			]);
			return { staging, verified, failed };
		},

		/**
		 * Move a checkpoint file between zones. The data layer does not decide
		 * lifecycles (that is the automaton's job); it only relocates the file
		 * atomically and leaves an audit event.
		 */
		async move(cpId: string, from: Zone, to: Zone): Promise<void> {
			if (!(await pathExists(fileFor(from, cpId)))) {
				throw new BlackboardDataError(
					`checkpoint ${cpId} not found in ${from}/`,
					fileFor(from, cpId),
				);
			}
			const checkpoint = await readYamlFile(
				fileFor(from, cpId),
				checkpointSchema,
			);
			await writeYamlFile(fileFor(to, cpId), checkpointSchema, checkpoint);
			await appendJsonlLine(paths.eventsFile, {
				timestamp: new Date().toISOString(),
				source: "blackboard",
				type: "checkpoint_moved",
				payload: { cpId, from, to },
			});
			if (to !== from) {
				// Remove only after the target copy is durably in place.
				const { rm } = await import("node:fs/promises");
				await rm(fileFor(from, cpId));
			}
		},

		async getForGoal(goalId: string): Promise<Checkpoint[]> {
			const all = await this.scanAll();
			return [...all.staging, ...all.verified, ...all.failed].filter(
				(cp) => cp.goal === goalId,
			);
		},
	};
}
