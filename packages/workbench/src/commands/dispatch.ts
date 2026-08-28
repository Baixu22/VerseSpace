import type { Command } from "commander";
import { emitJson, type GlobalOptions } from "../output";
import { dispatchGoal } from "../scheduler/dispatch";
import { resolveBlackboard } from "./context";

export async function dispatchCommand(
	goalId: string,
	workspotId: string | undefined,
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const result = await dispatchGoal(bb, goalId, workspotId);
	if (opts.json) {
		emitJson(result);
	} else if (!opts.quiet) {
		if (result.ok) {
			console.log(
				`已派发 ${result.goalId} → 工位 ${result.workspotId}（worktree ${result.worktree}）`,
			);
		} else {
			console.error(`派发失败：${result.reason}`);
		}
	}
	if (!result.ok) {
		process.exitCode = 1;
	}
}
