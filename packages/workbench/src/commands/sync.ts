import type { Command } from "commander";
import { emitJson, type GlobalOptions } from "../output";
import { runOnce } from "../runtime";
import type { WorkbenchEvent } from "../types/event";
import type { Goal } from "../types/goal";
import type { Transition } from "../types/transitions";
import { resolveBlackboard } from "./context";

function describeTransition(t: Transition): string {
	switch (t.type) {
		case "goal_status":
			return `goal_status: ${t.goalId} ${t.from} → ${t.to}（${t.reason}）`;
		case "mark_stale":
			return `mark_stale: ${t.goalId}（${t.reason}）`;
		case "checkpoint_lifecycle":
			return `checkpoint_lifecycle: ${t.cpId} ${t.from} → ${t.to}`;
		case "workspot_status":
			return `workspot_status: ${t.wsId} ${t.from} → ${t.to}（${t.reason}）`;
		case "enqueue_goal":
			return `enqueue_goal: ${t.goalId}`;
		case "request_verification":
			return `request_verification: ${t.cpId}`;
		case "refresh_context":
			return `refresh_context: ${t.wsId}`;
		case "notify_human":
			return `notify_human[${t.severity}]: ${t.message}`;
	}
}

export async function syncCommand(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const result = await runOnce(bb);
	if (opts.json) {
		emitJson(result);
		return;
	}
	if (opts.quiet) {
		return;
	}
	console.log(
		`runtime：计算 ${result.transitions.length} 个转移，应用 ${result.applied} 个`,
	);
	for (const transition of result.transitions) {
		console.log(`  - ${describeTransition(transition)}`);
	}
	for (const verification of result.verifications) {
		console.log(`  = 验证 ${verification.cpId}: ${verification.result.status}`);
	}
	for (const key of result.reanchored) {
		console.log(`  ~ 接口 ${key} 已重锚定到最新内容`);
	}
	for (const notification of result.notifications) {
		const tag =
			notification.severity === "error"
				? "错误"
				: notification.severity === "warning"
					? "警告"
					: "提示";
		console.log(`  ! [${tag}] ${notification.message}`);
	}
}

export async function statusCommand(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const snapshot = await bb.snapshot();
	const counts: Record<string, number> = {};
	for (const goal of snapshot.goals) {
		counts[goal.status] = (counts[goal.status] ?? 0) + 1;
	}
	const summary = {
		goals: { total: snapshot.goals.length, byStatus: counts },
		checkpoints: {
			staging: snapshot.checkpoints.staging.length,
			verified: snapshot.checkpoints.verified.length,
			failed: snapshot.checkpoints.failed.length,
		},
		workspots: snapshot.workspots.length,
		queue: snapshot.executionQueue,
		interfaces: snapshot.interfaces.length,
	};
	if (opts.json) {
		emitJson(summary);
		return;
	}
	if (opts.quiet) {
		return;
	}
	console.log(`目标：${snapshot.goals.length} 个`, JSON.stringify(counts));
	console.log(
		`checkpoint：staging ${summary.checkpoints.staging} / verified ${summary.checkpoints.verified} / failed ${summary.checkpoints.failed}`,
	);
	console.log(`工位：${snapshot.workspots.length} 个`);
	console.log(`执行队列：${snapshot.executionQueue.join(" → ") || "（空）"}`);
	console.log(`注册接口：${snapshot.interfaces.length} 个`);
}

/** Goal DAG as indented text: dependencies first, children indented below. */
export function renderMap(goals: Goal[]): string[] {
	const byId = new Map(goals.map((goal) => [goal.id, goal]));
	const children = new Map<string, string[]>();
	const roots: string[] = [];
	for (const goal of goals) {
		if (goal.dependsOn.length === 0) {
			roots.push(goal.id);
		}
		for (const dep of goal.dependsOn) {
			children.set(dep, [...(children.get(dep) ?? []), goal.id]);
		}
	}
	const lines: string[] = [];
	const seen = new Set<string>();
	const walk = (id: string, depth: number): void => {
		if (seen.has(id)) {
			lines.push(`${"  ".repeat(depth)}${id}（循环引用）`);
			return;
		}
		seen.add(id);
		const goal = byId.get(id);
		if (!goal) {
			lines.push(`${"  ".repeat(depth)}${id}（缺失）`);
			return;
		}
		lines.push(
			`${"  ".repeat(depth)}${goal.id} [${goal.status}] ${goal.title}`,
		);
		for (const child of (children.get(id) ?? []).sort()) {
			walk(child, depth + 1);
		}
	};
	for (const root of roots.sort()) {
		walk(root, 0);
	}
	for (const goal of goals) {
		if (!seen.has(goal.id)) {
			walk(goal.id, 0);
		}
	}
	return lines;
}

export async function mapCommand(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const goals = await bb.goals.list();
	if (opts.json) {
		emitJson({ map: renderMap(goals) });
		return;
	}
	if (opts.quiet) {
		return;
	}
	const lines = renderMap(goals);
	if (lines.length === 0) {
		console.log("（还没有目标）");
	}
	for (const line of lines) {
		console.log(line);
	}
}

export async function logCommand(
	options: { tail?: string },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const tail = Math.max(1, Number(options.tail ?? 20) || 20);
	const events: WorkbenchEvent[] = await bb.events.tail(tail);
	if (opts.json) {
		emitJson(events);
		return;
	}
	if (opts.quiet) {
		return;
	}
	if (events.length === 0) {
		console.log("（事件日志为空）");
	}
	for (const e of events) {
		console.log(`[${e.timestamp}] ${e.source}/${e.type}`);
	}
}
