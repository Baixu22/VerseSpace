/**
 * checkpoint restore — 回退 + diff 主安全网（TF-0098）。
 *
 * 三个动作必须是三个有明确标签的不同动作（Cursor 最持久的投诉就是
 * 「Restore Checkpoint 读起来像回滚对话但实际不是」）：
 *   --code      只恢复代码（git checkout 到采集时的 HEAD）
 *   --context   只恢复上下文（blackboard 键值回写旧值）
 *   --both      两者都恢复
 * 三者互斥且必须显式指定一个——不给默认值，避免语义含糊。
 *
 * 默认 dry-run 打印 diff；只有 --yes 才真的动手。每一次撤销都记为
 * 带标签的负样本事件（source=restore, type=undo）。
 */

import type { Command } from "commander";
import { CHECKPOINT_ZONES } from "../blackboard/checkpoints";
import { registryContextStore } from "../blackboard/context-store";
import { emitJson, type GlobalOptions } from "../output";
import { applyRollback, planRollback } from "../runtime/rollback";
import {
	type Checkpoint,
	type RollbackScope,
	SCOPE_LABELS,
} from "../types/checkpoint";
import { resolveBlackboard } from "./context";

async function findCheckpoint(
	// biome-ignore lint/suspicious/noExplicitAny: blackboard 类型由 openBlackboard 返回
	bb: any,
	id: string,
): Promise<Checkpoint | null> {
	for (const zone of CHECKPOINT_ZONES) {
		const found = (await bb.checkpoints.scanZone(zone)).find(
			(cp: Checkpoint) => cp.id === id,
		);
		if (found) {
			return found;
		}
	}
	return null;
}

function formatPlan(plan: Awaited<ReturnType<typeof planRollback>>): string[] {
	const lines: string[] = [
		`回退计划：checkpoint ${plan.checkpointId}　动作=${SCOPE_LABELS[plan.scope]}`,
	];
	if (plan.error) {
		lines.push(`✘ ${plan.error}`);
		return lines;
	}
	if (plan.code.length > 0) {
		lines.push("  代码：");
		for (const e of plan.code) {
			lines.push(
				`    ${e.changed ? "↺" : "·"} ${e.path}${e.changed ? "（将被还原）" : "（无变化）"}`,
			);
		}
	}
	if (plan.context.length > 0) {
		lines.push("  上下文：");
		for (const e of plan.context) {
			lines.push(
				`    ${e.changed ? "↺" : "·"} ${e.key}${e.changed ? "（将被还原）" : "（无变化）"}`,
			);
		}
	}
	lines.push(
		plan.pending === 0
			? "  无需回退（全部与快照一致）"
			: `  共 ${plan.pending} 项将被还原${plan.pending > 0 ? "（加 --yes 执行）" : ""}`,
	);
	return lines;
}

export async function checkpointRestore(
	id: string,
	options: {
		code?: boolean;
		context?: boolean;
		both?: boolean;
		yes?: boolean;
		label?: string;
	},
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;

	// 三个动作互斥且必选其一
	const chosen = [
		options.code ? "code" : null,
		options.context ? "context" : null,
		options.both ? "both" : null,
	].filter((s): s is RollbackScope => s !== null);
	if (chosen.length !== 1) {
		throw new Error(
			"restore 需要且只能指定一个动作：--code（只恢复代码）| --context（只恢复上下文）| --both（两者都恢复）",
		);
	}
	const scope = chosen[0]!;

	const bb = await resolveBlackboard();
	const checkpoint = await findCheckpoint(bb, id);
	if (!checkpoint) {
		throw new Error(`checkpoint 不存在：${id}`);
	}

	const workspot = await bb.state.workspots.get(checkpoint.workspot);
	const store = registryContextStore(bb);
	const plan = await planRollback(checkpoint, scope, {
		worktreePath: workspot?.worktreePath,
		store,
	});

	if (opts.json) {
		emitJson({ ...plan, executed: false });
		if (plan.error) {
			process.exitCode = 1;
		}
		return;
	}

	for (const line of formatPlan(plan)) {
		console.log(line);
	}
	if (plan.error) {
		process.exitCode = 1;
		return;
	}
	if (!options.yes) {
		if (!opts.quiet) {
			console.log("（dry-run：未做任何改动；加 --yes 执行）");
		}
		return;
	}
	if (plan.pending === 0) {
		if (!opts.quiet) {
			console.log("无需回退。");
		}
		return;
	}

	const result = await applyRollback(plan, checkpoint, {
		worktreePath: workspot?.worktreePath,
		store,
	});
	if (!result.ok) {
		console.error(`workbench: ${result.reason}`);
		process.exitCode = 1;
		return;
	}

	// 每一次撤销都记为带标签的负样本（TF-0098 requirement 3）
	await bb.events.append({
		timestamp: new Date().toISOString(),
		source: "restore",
		type: "undo",
		payload: {
			scope,
			label: options.label ?? SCOPE_LABELS[scope],
			checkpointId: checkpoint.id,
			assertion: checkpoint.assertion,
			files: result.code,
			keys: result.context,
		},
	});

	if (!opts.quiet) {
		console.log(
			`已完成${SCOPE_LABELS[scope]}：代码 ${result.code.length} 项、上下文 ${result.context.length} 项（记为负样本 undo/${scope}）`,
		);
	}
}
