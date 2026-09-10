import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cli, type E2EWorkspace } from "./driver";

export async function makeTempWorkspace(): Promise<E2EWorkspace> {
	const root = await mkdtemp(join(tmpdir(), "workbench-e2e-"));
	const entry = resolve(import.meta.dir, "..", "..", "src", "index.ts");
	return {
		projectDir: root,
		entry,
		agentScript: resolve(import.meta.dir, "fake-agent.ts"),
	};
}

/** 一个真实 git 仓库 + 种子文件 + `workbench init` 落出的 .workbench。 */
export async function seedProject(ws: E2EWorkspace): Promise<void> {
	const git = (args: string[]) =>
		new Promise<void>((done, fail) => {
			const proc = spawn("git", args, { cwd: ws.projectDir });
			proc.on("exit", (code) =>
				code === 0
					? done()
					: fail(new Error(`git ${args.join(" ")} -> ${code}`)),
			);
			proc.on("error", fail);
		});
	const { mkdir } = await import("node:fs/promises");
	await mkdir(join(ws.projectDir, "src"), { recursive: true });
	await writeFile(
		join(ws.projectDir, "src", "notes.md"),
		"# notes\n\n集成测试种子文件。\n",
		"utf8",
	);
	await writeFile(
		join(ws.projectDir, "src", "alpha.ts"),
		'export const alpha = "v1";\n',
		"utf8",
	);
	await writeFile(
		join(ws.projectDir, "src", "beta.ts"),
		"export const beta = 1;\n",
		"utf8",
	);
	await git(["init"]);
	await git(["-c", "user.email=e2e@local", "-c", "user.name=e2e", "add", "."]);
	await git([
		"-c",
		"user.email=e2e@local",
		"-c",
		"user.name=e2e",
		"commit",
		"-m",
		"seed",
	]);
	await cli(ws, ["--json", "init", "--project", ws.projectDir]);
	if (!existsSync(join(ws.projectDir, ".workbench"))) {
		throw new Error("workbench init 未产出 .workbench");
	}
}
