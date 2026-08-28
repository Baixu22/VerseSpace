import type { Command } from "commander";
import { emitJson, type GlobalOptions } from "../output";
import type { Goal } from "../types/goal";
import { resolveBlackboard } from "./context";

function humanGoal(goal: Goal): string {
	return `${goal.status.padEnd(12)} ${goal.id}  ${goal.title}`;
}

export async function goalAdd(
	title: string,
	options: { dependsOn?: string; acceptance?: string[] },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const goal = await bb.goals.add({
		title,
		dependsOn: options.dependsOn
			? options.dependsOn
					.split(",")
					.map((id) => id.trim())
					.filter(Boolean)
			: [],
		acceptance: (options.acceptance ?? []).map((assertion) => ({ assertion })),
	});
	if (opts.json) {
		emitJson(goal);
	} else if (!opts.quiet) {
		console.log(`已创建目标 ${goal.id}：${goal.title}`);
	}
}

export async function goalList(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const goals = await bb.goals.list();
	if (opts.json) {
		emitJson(goals);
	} else if (!opts.quiet) {
		if (goals.length === 0) {
			console.log("（还没有目标，用 workbench goal add 创建）");
		}
		for (const goal of goals) {
			console.log(humanGoal(goal));
		}
	}
}

export async function goalShow(id: string, command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const goal = await bb.goals.get(id);
	if (!goal) {
		throw new Error(`目标不存在：${id}`);
	}
	if (opts.json) {
		emitJson(goal);
	} else if (!opts.quiet) {
		console.log(`${goal.id} [${goal.status}] ${goal.title}`);
		console.log(`  依赖: ${goal.dependsOn.join(", ") || "（无）"}`);
		console.log(`  锚定: ${JSON.stringify(goal.verifiedAgainst.interfaces)}`);
		for (const criterion of goal.acceptance) {
			console.log(`  验收: ${criterion.assertion}`);
		}
		if (goal.staleReason) {
			console.log(`  stale 原因: ${goal.staleReason}`);
		}
	}
}

export async function goalCancel(id: string, command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const goal = await bb.goals.update(id, { status: "cancelled" });
	if (opts.json) {
		emitJson(goal);
	} else if (!opts.quiet) {
		console.log(`目标 ${goal.id} 已取消`);
	}
}
