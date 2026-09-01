import type { Command } from "commander";
import { openBlackboard } from "../blackboard";
import { runDoctor } from "../doctor";
import { emitJson, type GlobalOptions } from "../output";
import { findWorkbenchRoot } from "../paths";
import { formatRotHeadline, runContextRot } from "../rot/scan";

/**
 * `workbench doctor` is the acquisition hook (TF-0104) first, and the
 * blackboard consistency sweep second.
 *
 * Context-rot needs no `.workbench/` — it runs on any checkout, reads the
 * instruction files a human already wrote, and prints two numbers. The
 * blackboard sweep still runs when a workspace exists, but it never blocks
 * the headline: `N 条架构断言，M 条已失效`.
 */
export async function doctorCommand(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const cwd = process.cwd();
	const rot = await runContextRot(cwd);
	const workbenchRoot = await findWorkbenchRoot(cwd);
	const blackboard = workbenchRoot
		? await runDoctor(openBlackboard(workbenchRoot))
		: null;

	if (opts.json) {
		emitJson({ rot, blackboard });
	} else if (!opts.quiet) {
		console.log(formatRotHeadline(rot));
		const stale = rot.findings.filter((item) => item.stale);
		for (const finding of stale) {
			console.log(`  ${finding.source}:${finding.line}  ${finding.ref}`);
		}
		if (blackboard) {
			if (blackboard.issues.length === 0) {
				console.log("blackboard doctor：一切正常 ✓");
			}
			for (const issue of blackboard.issues) {
				const tag = issue.severity === "error" ? "错误" : "警告";
				console.log(`[${tag}] ${issue.check}: ${issue.message}`);
			}
			if (blackboard.issues.length > 0) {
				console.log(
					blackboard.ok
						? `blackboard doctor：无错误（${blackboard.issues.length} 条警告）`
						: "blackboard doctor：发现错误，见上",
				);
			}
		}
	}

	const rotFailed = rot.stale > 0;
	const blackboardFailed = blackboard !== null && !blackboard.ok;
	process.exitCode = rotFailed || blackboardFailed ? 1 : 0;
}
