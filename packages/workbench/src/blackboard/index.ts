import { dirname } from "node:path";
import { pathExists } from "../fs/atomic";
import { type WorkbenchPaths, workbenchPaths } from "../paths";
import { tribunalApi } from "../tribunal/queue";
import {
	type WorkbenchConfig,
	type WorkbenchConfigInput,
	workbenchConfigSchema,
} from "../types/config";
import { readYamlFile, writeYamlFile } from "../yamlio";
import { checkpointsApi } from "./checkpoints";
import { decisionsApi } from "./decisions";
import { eventsApi } from "./events";
import { goalsApi } from "./goals";
import { interfacesApi } from "./interfaces";
import { metricsApi } from "./metrics";
import { sessionsApi } from "./sessions";
import { getWorldSnapshot } from "./snapshot";
import { stateApi } from "./state";

/**
 * The Blackboard is the only channel through which modules touch
 * `.workbench/` state. It returns plain validated objects; callers mutate by
 * calling update/save APIs, never by editing returned references.
 */
export interface Blackboard {
	paths: WorkbenchPaths;
	/** Repository root that contains the `.workbench/` directory. */
	projectRoot: string;
	config: {
		load(): Promise<WorkbenchConfig>;
		save(config: WorkbenchConfigInput): Promise<void>;
	};
	goals: ReturnType<typeof goalsApi>;
	decisions: ReturnType<typeof decisionsApi>;
	interfaces: ReturnType<typeof interfacesApi>;
	state: ReturnType<typeof stateApi>;
	checkpoints: ReturnType<typeof checkpointsApi>;
	events: ReturnType<typeof eventsApi>;
	sessions: ReturnType<typeof sessionsApi>;
	/** R3: the adjudication queue — where a human decision is requested. */
	tribunal: ReturnType<typeof tribunalApi>;
	/** R3: per-lane usage counters (absolute tokens, cache, compactions). */
	metrics: ReturnType<typeof metricsApi>;
	snapshot(): Promise<Awaited<ReturnType<typeof getWorldSnapshot>>>;
}

export function openBlackboard(workbenchRoot: string): Blackboard {
	const paths = workbenchPaths(workbenchRoot);
	const projectRoot = dirname(workbenchRoot);

	const events = eventsApi(paths);

	const bb: Blackboard = {
		paths,
		projectRoot,
		config: {
			async load(): Promise<WorkbenchConfig> {
				if (!(await pathExists(paths.config))) {
					return workbenchConfigSchema.parse({});
				}
				return readYamlFile(paths.config, workbenchConfigSchema);
			},
			async save(config: WorkbenchConfigInput): Promise<void> {
				const canonical = workbenchConfigSchema.parse(config);
				await writeYamlFile(paths.config, workbenchConfigSchema, canonical);
			},
		},
		goals: goalsApi(paths),
		decisions: decisionsApi(paths),
		interfaces: interfacesApi(paths, projectRoot),
		state: stateApi(paths),
		checkpoints: checkpointsApi(paths, {
			append: async (event) => {
				await events.append(event);
			},
		}),
		events,
		sessions: sessionsApi(paths, {
			append: (event) => events.append(event),
			appendMany: (batch) => events.appendMany(batch),
		}),
		tribunal: tribunalApi(paths, {
			append: async (event) => {
				await events.append(event);
			},
		}),
		metrics: metricsApi(paths),
		snapshot() {
			return getWorldSnapshot(bb);
		},
	};
	return bb;
}
