import type { Command } from "commander";
import { emitJson, type GlobalOptions } from "../output";
import { resolveBlackboard } from "./context";

export async function decisionAdd(
	title: string,
	options: { rationale?: string; author?: string },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	if (!options.rationale) {
		throw new Error("decision add 需要 --rationale 说明理由");
	}
	const bb = await resolveBlackboard();
	const decision = await bb.decisions.add({
		title,
		rationale: options.rationale,
		author: options.author ?? "human",
	});
	if (opts.json) {
		emitJson(decision);
	} else if (!opts.quiet) {
		console.log(`已记录决策 ${decision.id}：${decision.title}`);
	}
}
