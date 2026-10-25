import type { Command } from "commander";
import { revalidateArtifact } from "../artifacts/revalidate";
import { emitJson, type GlobalOptions } from "../output";
import { resolveBlackboard } from "./context";

export async function checkpointRevalidate(
	id: string,
	options: { workspot?: string; targetRef?: string; targetCandidate?: boolean },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const result = await revalidateArtifact(
		await resolveBlackboard(),
		id,
		options,
	);
	if (opts.json) emitJson(result);
	else if (!opts.quiet)
		console.log(
			`重验 ${result.id}：${result.verificationResult?.status ?? "unknown"}；${result.verificationBindingIssue ?? "保留原始产物来源，不重复应用效果"}`,
		);
	if (
		result.verificationResult?.status !== "passed" ||
		result.verificationBindingIssue
	)
		process.exitCode = 1;
}
