import { readFile, stat } from "node:fs/promises";
import type { Command } from "commander";
import { receiveArtifactManifest } from "../artifacts/receive";
import { emitJson, type GlobalOptions, WorkbenchError } from "../output";
import { resolveBlackboard } from "./context";

export async function checkpointReceive(
	file: string,
	options: {
		checkpoint: string;
		workspot: string;
		report: string;
		revalidate?: boolean;
	},
	command: Command,
) {
	const opts = command.optsWithGlobals() as GlobalOptions;
	if ((await stat(file)).size > 1_000_000)
		throw new WorkbenchError("证据清单超过 1 MB", 2);
	const result = await receiveArtifactManifest(
		await resolveBlackboard(),
		await readFile(file, "utf8"),
		options,
	);
	if (opts.json) emitJson(result);
	else if (!opts.quiet)
		console.log(
			`${result.status}：${result.reasons.join("；") || "声明对象与目标已核对，尚未执行本机检查"}`,
		);
	if (result.status === "unknown") process.exitCode = 2;
	else if (
		result.status === "rejected" ||
		result.status === "revalidation-required" ||
		result.status === "failed"
	)
		process.exitCode = 1;
}
