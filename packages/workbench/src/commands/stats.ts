import type { Command } from "commander";
import { collectChatStats } from "../chat/stats";
import { emitJson, type GlobalOptions } from "../output";
import { resolveBlackboard } from "./context";

export async function statsCommand(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const stats = await collectChatStats(bb);

	if (opts.json) {
		emitJson(stats);
		return;
	}
	if (opts.quiet) {
		return;
	}

	console.log(`线程：${stats.threads.total}`);
	console.log(
		`分叉：${stats.forks.total}（每周 ${
			stats.forks.perWeek ?? "样本不足"
		}，深度 ${stats.forks.depth.min}-${stats.forks.depth.max}）`,
	);
	console.log(
		`恢复笔记：${stats.threads.withResumeNotes}；足迹：${stats.threads.withFootprints}`,
	);
	console.log(
		`观察窗口：${stats.observation.days.toFixed(1)} 天（${stats.observation.startedAt ?? "无"} → ${stats.observation.endedAt ?? "无"}）`,
	);
	if (!stats.siblingAlternation.available) {
		console.log(`兄弟交替：暂不可测（${stats.siblingAlternation.reason}）`);
	}
	if (stats.dataQuality.insufficientHistory) {
		console.log(`数据质量：insufficient-history`);
		for (const reason of stats.dataQuality.reasons) {
			console.log(`  - ${reason}`);
		}
	}
}
