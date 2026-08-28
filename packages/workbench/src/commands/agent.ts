import type { Command } from "commander";
import { startAgent } from "../agents/runner";
import { emitJson, type GlobalOptions } from "../output";
import { resolveBlackboard } from "./context";

export async function agentRun(
	options: { workspot?: string; prompt?: string },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	if (!options.workspot) {
		throw new Error("agent run 需要 --workspot <id>");
	}
	const bb = await resolveBlackboard();
	const workspot = await bb.state.workspots.get(options.workspot);
	if (!workspot) {
		throw new Error(`工位不存在：${options.workspot}`);
	}

	// Default prompt: the task plus its acceptance criteria; the worktree
	// already contains the generated .agent-context.md with the full picture.
	let prompt = options.prompt;
	if (!prompt) {
		const taskId = workspot.currentTask ?? workspot.primaryTask;
		const goal = await bb.goals.get(taskId);
		const acceptance = (goal?.acceptance ?? [])
			.map((criterion) => `- ${criterion.assertion}`)
			.join("\n");
		prompt = [
			`完成任务：${goal?.title ?? taskId}（${taskId}）`,
			acceptance ? `验收条件：\n${acceptance}` : "",
			"先阅读 .agent-context.md 了解约束，完成后在 .workbench/checkpoints/staging/ 落 checkpoint。",
		]
			.filter(Boolean)
			.join("\n\n");
	}

	const result = await startAgent(bb, {
		workspotId: workspot.id,
		prompt,
	});
	if (opts.json) {
		emitJson(result);
	} else if (!opts.quiet) {
		if (result.ok) {
			console.log(
				`agent 已启动（${workspot.id}，流式日志 ${result.logFile}）；状态看 workbench ui 或 .workbench/agents/${workspot.id}/latest.json`,
			);
		} else {
			console.error(`workbench: ${result.reason}`);
		}
	}
	if (!result.ok) {
		process.exitCode = 1;
	}
}
