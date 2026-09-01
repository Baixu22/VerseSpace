import { join } from "node:path";
import { z } from "zod";
import type { UsageSample } from "../agents/usage";
import { safeReaddir } from "../fs/atomic";
import type { WorkbenchPaths } from "../paths";
import { readYamlFile, writeYamlFile } from "../yamlio";

/**
 * Per-lane usage counters (R3 / TF-0084). One file per workspot under
 * `state/metrics/`, same convention as the rest of state: two writers can
 * never lose each other's file, and a reader can list every lane while one of
 * them is mid-write.
 *
 * What is stored is only what was OBSERVED. Everything a human actually reads
 * — absolute token total, cache hit rate, tool-result share — is derived at
 * read time by `derive()`, so a change in how we compute a ratio never
 * silently disagrees with the number already on disk.
 *
 * Lane keys are workspot ids. Interactive chat threads (chat/threads.ts)
 * also parse stream-json, but a thread is not a lane — metering it here
 * would mix non-lane keys into "three numbers per lane". Chat usage stays
 * off this directory (TF-0118).
 */

export const laneMetricsSchema = z.object({
	workspot: z.string().min(1),
	/** Absolute counters, never percentages. */
	inputTokens: z.number().int().nonnegative().default(0),
	outputTokens: z.number().int().nonnegative().default(0),
	cacheCreationTokens: z.number().int().nonnegative().default(0),
	cacheReadTokens: z.number().int().nonnegative().default(0),
	toolCalls: z.number().int().nonnegative().default(0),
	toolResultBytes: z.number().int().nonnegative().default(0),
	assistantTextBytes: z.number().int().nonnegative().default(0),
	/** Turns observed with any cache read at all. */
	turns: z.number().int().nonnegative().default(0),
	cacheHitTurns: z.number().int().nonnegative().default(0),
	compactions: z.number().int().nonnegative().default(0),
	consecutiveFailures: z.number().int().nonnegative().default(0),
	updatedAt: z.string(),
});
export type LaneMetrics = z.infer<typeof laneMetricsSchema>;

export interface DerivedLaneMetrics extends LaneMetrics {
	/** input + output + cache creation + cache read — the number that matters. */
	absoluteTokens: number;
	/** cacheReadTurns / turns, 0..1. */
	cacheHitRate: number;
	/** Share of the lane's observed bytes that came back from tools, 0..1. */
	toolResultShare: number;
}

export function emptyLaneMetrics(workspot: string): LaneMetrics {
	return laneMetricsSchema.parse({
		workspot,
		updatedAt: new Date().toISOString(),
	});
}

/**
 * Fold what a lane saw into the stored counters.
 *
 * A `failed` result bumps the consecutive-failure counter; a success resets
 * it. Consecutive — not total — is the signal that matters: three failures in
 * a row means the lane is stuck, three failures across a day means nothing.
 */
export function foldUsage(
	current: LaneMetrics,
	sample: UsageSample,
	at = new Date().toISOString(),
): LaneMetrics {
	const sawCache = sample.cacheReadTokens > 0;
	const countedTurn =
		sample.inputTokens + sample.cacheCreationTokens + sample.cacheReadTokens >
		0;
	return {
		...current,
		inputTokens: current.inputTokens + sample.inputTokens,
		outputTokens: current.outputTokens + sample.outputTokens,
		cacheCreationTokens:
			current.cacheCreationTokens + sample.cacheCreationTokens,
		cacheReadTokens: current.cacheReadTokens + sample.cacheReadTokens,
		toolCalls: current.toolCalls + sample.toolCalls,
		toolResultBytes: current.toolResultBytes + sample.toolResultBytes,
		assistantTextBytes: current.assistantTextBytes + sample.assistantTextBytes,
		turns: current.turns + (countedTurn ? 1 : 0),
		cacheHitTurns: current.cacheHitTurns + (sawCache && countedTurn ? 1 : 0),
		compactions: current.compactions + (sample.compaction ? 1 : 0),
		consecutiveFailures: sample.failed ? current.consecutiveFailures + 1 : 0,
		updatedAt: at,
	};
}

export function derive(lane: LaneMetrics): DerivedLaneMetrics {
	const absoluteTokens =
		lane.inputTokens +
		lane.outputTokens +
		lane.cacheCreationTokens +
		lane.cacheReadTokens;
	const bytes = lane.toolResultBytes + lane.assistantTextBytes;
	return {
		...lane,
		absoluteTokens,
		cacheHitRate: lane.turns === 0 ? 0 : lane.cacheHitTurns / lane.turns,
		toolResultShare: bytes === 0 ? 0 : lane.toolResultBytes / bytes,
	};
}

export function metricsApi(paths: WorkbenchPaths) {
	function fileFor(workspot: string): string {
		return join(
			paths.metrics,
			`${workspot.replace(/[^A-Za-z0-9._-]/g, "_")}.yaml`,
		);
	}

	async function read(workspot: string): Promise<LaneMetrics> {
		try {
			return await readYamlFile(fileFor(workspot), laneMetricsSchema);
		} catch {
			return emptyLaneMetrics(workspot);
		}
	}

	return {
		async get(workspot: string): Promise<LaneMetrics> {
			return read(workspot);
		},

		/**
		 * Merge one observed sample into the lane's counters.
		 *
		 * Only for one-shot merges. A long-running capture must fold each
		 * sample as it arrives and `save` the result: accumulating samples
		 * first would collapse a run's turns into one, and the cache hit rate
		 * is a PER-TURN number — three turns folded as one would report 100%.
		 */
		async record(workspot: string, sample: UsageSample): Promise<LaneMetrics> {
			const next = foldUsage(await read(workspot), sample);
			await writeYamlFile(fileFor(workspot), laneMetricsSchema, next);
			return next;
		},

		/** Persist a lane's counters wholesale (the long-running capture path). */
		async save(workspot: string, lane: LaneMetrics): Promise<LaneMetrics> {
			await writeYamlFile(fileFor(workspot), laneMetricsSchema, lane);
			return lane;
		},

		async list(): Promise<DerivedLaneMetrics[]> {
			const names = await safeReaddir(paths.metrics);
			const lanes = await Promise.all(
				names
					.filter((name) => name.endsWith(".yaml"))
					.map(async (name) => {
						try {
							return await readYamlFile(
								join(paths.metrics, name),
								laneMetricsSchema,
							);
						} catch {
							return null; // torn file: the panel stays readable
						}
					}),
			);
			return lanes
				.filter((lane): lane is LaneMetrics => lane !== null)
				.map(derive)
				.sort((a, b) => a.workspot.localeCompare(b.workspot));
		},

		/** Drop a lane's counters (a reset workspot starts from zero). */
		async reset(workspot: string): Promise<void> {
			await writeYamlFile(fileFor(workspot), laneMetricsSchema, {
				...emptyLaneMetrics(workspot),
				updatedAt: new Date().toISOString(),
			});
		},
	};
}
