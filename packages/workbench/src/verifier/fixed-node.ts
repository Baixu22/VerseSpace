import { hashFile } from "../hash";
import { resolveSpawnCommand } from "../supervisor/argv";
import { executeVerification } from "./execute";
/** Native Windows runtime variables only: no inherited model keys, NODE_OPTIONS or proxy. */
export function runnerEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ARTIFACT_FIXED_COPY: "1" };
	for (const key of [
		"SystemRoot",
		"SystemDrive",
		"windir",
		"ComSpec",
		"PATHEXT",
		"APPDATA",
		"LOCALAPPDATA",
		"TEMP",
		"TMP",
	])
		if (process.env[key]) env[key] = process.env[key];
	return env;
}

export async function fixedNodeRunner(cwd: string) {
	const node = await resolveSpawnCommand(["node"]);
	if (!node || !/node(?:\.exe)?$/i.test(node.file))
		throw new Error("Node 原生运行器不可用");
	const probe = await executeVerification(
		[node.file, "--version"],
		cwd,
		5,
		runnerEnvironment(),
	);
	const version = probe.output.trim();
	if (probe.exitCode !== 0 || !/^v(?:2[4-9]|[3-9]\d)\./.test(version))
		throw new Error("固定副本模式要求 Node 24 或更新的权限/模块钩子运行器");
	return {
		file: node.file,
		runner: {
			name: "node" as const,
			version,
			executableHash: await hashFile(node.file),
		},
	};
}
