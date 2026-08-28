import { dirname } from "node:path";
import { pathExists } from "../fs/atomic";
import { type WorkbenchPaths, workbenchPaths } from "../paths";
import { type WorkbenchConfig, workbenchConfigSchema } from "../types/config";
import { readYamlFile, writeYamlFile } from "../yamlio";
import { checkpointsApi } from "./checkpoints";
import { decisionsApi } from "./decisions";
import { eventsApi } from "./events";
import { goalsApi } from "./goals";
import { interfacesApi } from "./interfaces";
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
		save(config: WorkbenchConfig): Promise<void>;
	};
	goals: ReturnType<typeof goalsApi>;
	decisions: ReturnType<typeof decisionsApi>;
	interfaces: ReturnType<typeof interfacesApi>;
	state: ReturnType<typeof stateApi>;
	checkpoints: ReturnType<typeof checkpointsApi>;
	events: ReturnType<typeof eventsApi>;
	snapshot(): Promise<Awaited<ReturnType<typeof getWorldSnapshot>>>;
}

export function openBlackboard(workbenchRoot: string): Blackboard {
	const paths = workbenchPaths(workbenchRoot);
	const projectRoot = dirname(workbenchRoot);

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
			async save(config: WorkbenchConfig): Promise<void> {
				await writeYamlFile(paths.config, workbenchConfigSchema, config);
			},
		},
		goals: goalsApi(paths),
		decisions: decisionsApi(paths),
		interfaces: interfacesApi(paths, projectRoot),
		state: stateApi(paths),
		checkpoints: checkpointsApi(paths),
		events: eventsApi(paths),
		snapshot() {
			return getWorldSnapshot(bb);
		},
	};
	return bb;
}
