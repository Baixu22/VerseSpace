import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../git";
import { makeTempWorkbench } from "./fixtures";

async function run(projectDir: string, args: string[]): Promise<void> {
	const result = await git(
		["-c", "user.email=t@local", "-c", "user.name=t", ...args],
		projectDir,
	);
	if (!result.ok) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

export async function makeCommittedRepo() {
	const ws = await makeTempWorkbench();
	await writeFile(join(ws.projectDir, "README.md"), "# repo\n");
	await run(ws.projectDir, ["init", "-q", "-b", "main"]);
	await run(ws.projectDir, ["add", "README.md"]);
	await run(ws.projectDir, ["commit", "-qm", "init"]);
	return ws;
}

export async function commitOnBranch(
	projectDir: string,
	branch: string,
	readme: string,
): Promise<void> {
	await run(projectDir, ["checkout", "-q", "-b", branch, "main"]);
	await writeFile(join(projectDir, "README.md"), readme);
	await run(projectDir, ["commit", "-qam", `change on ${branch}`]);
	await run(projectDir, ["checkout", "-q", "main"]);
}
