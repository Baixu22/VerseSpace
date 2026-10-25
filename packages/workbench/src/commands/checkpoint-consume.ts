import type { Command } from "commander";
import { consumeArtifact } from "../artifacts/consume";
import { emitJson, type GlobalOptions } from "../output";
import { resolveBlackboard } from "./context";

export async function checkpointConsume(
	id: string,
	options: { evidence: string },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const result = await consumeArtifact(
		await resolveBlackboard(),
		id,
		options.evidence,
	);
	if (opts.json) emitJson(result);
	else if (!opts.quiet)
		console.log(
			result.ok
				? `已消费产物验收 ${id}（检查 ${options.evidence}）`
				: `产物验收拒绝：${result.reason}`,
		);
	if (!result.ok) process.exitCode = 1;
}
