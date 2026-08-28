import type { Command } from "commander";
import { runDoctor } from "../doctor";
import { emitJson, type GlobalOptions } from "../output";
import { resolveBlackboard } from "./context";

export async function doctorCommand(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const report = await runDoctor(bb);
	if (opts.json) {
		emitJson(report);
	} else if (!opts.quiet) {
		if (report.issues.length === 0) {
			console.log("doctor：一切正常 ✓");
		}
		for (const issue of report.issues) {
			const tag = issue.severity === "error" ? "错误" : "警告";
			console.log(`[${tag}] ${issue.check}: ${issue.message}`);
		}
		console.log(
			report.ok
				? `doctor：无错误（${report.issues.length} 条警告）`
				: "doctor：发现错误，见上",
		);
	}
	process.exitCode = report.ok ? 0 : 1;
}
