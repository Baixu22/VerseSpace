import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { pathExists } from "../fs/atomic";
import { emitJson, type GlobalOptions } from "../output";
import { workbenchPaths } from "../paths";
import { workbenchConfigSchema } from "../types/config";

export interface InitResult {
	ok: true;
	workbenchRoot: string;
	created: string[];
	existing: string[];
}

const LAYOUT_DIRS = [
	"root",
	"blackboard",
	"goals",
	"decisions",
	"interfaces",
	"state",
	"workspots",
	"queue",
	"tribunal",
	"sessions",
	"metrics",
	"checkpoints",
	"staging",
	"verified",
	"failed",
	"eventsDir",
] as const;

/**
 * Idempotent scaffold of the `.workbench/` directory. Re-running never
 * overwrites: existing files and directories are reported, not touched.
 */
export async function initWorkbench(projectDir: string): Promise<InitResult> {
	const paths = workbenchPaths(join(resolve(projectDir), ".workbench"));
	const created: string[] = [];
	const existing: string[] = [];

	for (const key of LAYOUT_DIRS) {
		const dir = paths[key];
		if (await pathExists(dir)) {
			existing.push(dir);
		} else {
			await mkdir(dir, { recursive: true });
			created.push(dir);
		}
	}

	if (await pathExists(paths.config)) {
		existing.push(paths.config);
	} else {
		const defaults = workbenchConfigSchema.parse({ project: projectDir });
		await writeFile(paths.config, stringify(defaults), "utf8");
		created.push(paths.config);
	}

	if (await pathExists(paths.eventsFile)) {
		existing.push(paths.eventsFile);
	} else {
		await writeFile(paths.eventsFile, "", "utf8");
		created.push(paths.eventsFile);
	}

	return { ok: true, workbenchRoot: paths.root, created, existing };
}

export async function initCommand(
	projectDir: string,
	options: GlobalOptions,
): Promise<void> {
	const result = await initWorkbench(projectDir);
	if (options.json) {
		emitJson(result);
	} else if (!options.quiet) {
		console.log(
			`workbench: ready at ${result.workbenchRoot} (${result.created.length} created, ${result.existing.length} already present)`,
		);
	}
}
