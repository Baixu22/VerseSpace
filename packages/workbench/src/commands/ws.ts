import type { Command } from "commander";
import { branchNameProblem, normalizeBranchName } from "../git/refname";
import { emitJson, type GlobalOptions } from "../output";
import type { Workspot } from "../types/workspot";
import { resolveBlackboard } from "./context";

export async function wsCreate(
	id: string,
	options: { task?: string; branch?: string; worktree?: string },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	if (!options.task || !options.branch) {
		throw new Error("ws create 需要 --task <goal-id> 和 --branch <branch>");
	}
	const bb = await resolveBlackboard();
	if (await bb.state.workspots.get(id)) {
		throw new Error(`工位 ${id} 已存在`);
	}
	// TF-0117: refuse an unusable branch name here, where the person who typed
	// it is still watching, instead of letting it surface as a bare `fatal:`
	// from `git worktree add` at dispatch time.
	const branch = normalizeBranchName(options.branch);
	const problem = branchNameProblem(branch);
	if (problem !== null) {
		throw new Error(`分支名 ${options.branch} 不是合法 git ref：${problem}`);
	}
	const workspot: Workspot = {
		id,
		branch,
		worktreePath: options.worktree ?? `worktrees/${id}`,
		primaryTask: options.task,
		binding: "primary",
		status: "idle",
		contextNeeds: { decisions: [], interfaces: [] },
	};
	await bb.state.workspots.save(workspot);
	if (opts.json) {
		emitJson(workspot);
	} else if (!opts.quiet) {
		console.log(
			`已创建工位 ${workspot.id}（任务 ${workspot.primaryTask}，worktree ${workspot.worktreePath}）`,
		);
	}
}

export async function wsList(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const workspots = await bb.state.workspots.list();
	if (opts.json) {
		emitJson(workspots);
	} else if (!opts.quiet) {
		if (workspots.length === 0) {
			console.log("（还没有工位，用 workbench ws create）");
		}
		for (const ws of workspots) {
			console.log(
				`${ws.id.padEnd(16)} ${ws.status.padEnd(10)} ${ws.binding.padEnd(9)} ${ws.currentTask ?? ws.primaryTask}`,
			);
		}
	}
}

export async function wsStatus(id: string, command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const workspot = await bb.state.workspots.get(id);
	if (!workspot) {
		throw new Error(`工位不存在：${id}`);
	}
	if (opts.json) {
		emitJson(workspot);
	} else if (!opts.quiet) {
		console.log(`${workspot.id} [${workspot.status}/${workspot.binding}]`);
		console.log(`  分支: ${workspot.branch}`);
		console.log(`  worktree: ${workspot.worktreePath}`);
		console.log(`  主任务: ${workspot.primaryTask}`);
		if (workspot.currentTask) {
			console.log(`  当前任务: ${workspot.currentTask}`);
		}
	}
}

export async function wsReassign(
	id: string,
	options: { task?: string; temporary?: boolean },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	if (!options.task) {
		throw new Error("ws reassign 需要 --task <goal-id>");
	}
	const bb = await resolveBlackboard();
	const workspot = await bb.state.workspots.get(id);
	if (!workspot) {
		throw new Error(`工位不存在：${id}`);
	}
	const next: Workspot = options.temporary
		? { ...workspot, binding: "borrowed", currentTask: options.task }
		: {
				...workspot,
				binding: "primary",
				primaryTask: options.task,
				currentTask: undefined,
			};
	await bb.state.workspots.save(next);
	if (opts.json) {
		emitJson(next);
	} else if (!opts.quiet) {
		const target = options.temporary
			? `借用施工 ${options.task}`
			: `改派主任务 ${options.task}`;
		console.log(`工位 ${id}：${target}`);
	}
}
