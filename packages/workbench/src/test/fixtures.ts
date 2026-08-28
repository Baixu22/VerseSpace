import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Blackboard, openBlackboard } from "../blackboard";
import { initWorkbench } from "../commands/init";

export interface TempWorkbench {
	projectDir: string;
	/** `.workbench/` directory inside projectDir. */
	workbenchRoot: string;
	bb: Blackboard;
	cleanup(): Promise<void>;
}

/** Initialized scratch workspace; each test gets an isolated temp directory. */
export async function makeTempWorkbench(): Promise<TempWorkbench> {
	const projectDir = await mkdtemp(join(tmpdir(), "workbench-test-"));
	await initWorkbench(projectDir);
	const workbenchRoot = join(projectDir, ".workbench");
	const bb = openBlackboard(workbenchRoot);
	return {
		projectDir,
		workbenchRoot,
		bb,
		cleanup: () => rm(projectDir, { recursive: true, force: true }),
	};
}
