import type { Command } from "commander";
import { emitJson, type GlobalOptions } from "../output";
import { explainWip, observeFlow } from "../scheduler/wip";
import { resolveBlackboard } from "./context";

/**
 * `workbench wip` — the point of TF-0083 is that this command has nothing to
 * configure. It reports a number the system derived from what it actually did,
 * and when it could not derive one, it says so instead of printing a default
 * someone would start tuning.
 */
export async function wipCommand(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const flow = await observeFlow(bb);
	if (opts.json) {
		emitJson({ ...flow, explanation: explainWip(flow) });
		return;
	}
	if (opts.quiet) {
		return;
	}
	console.log(explainWip(flow));
	console.log(
		`在制 ${flow.inFlight} / 上限 ${flow.wipLimit}（可用令牌 ${flow.tokensFree}）`,
	);
	console.log(
		`未复核积压 ${flow.unreviewedBacklog} 项 —— 这是全局唯一真正共享的数`,
	);
	if (flow.completed > 0) {
		console.log(
			`样本：${flow.windowMinutes} 分钟内完成 ${flow.completed} 项，` +
				`平均停留 ${Math.round(flow.meanResidenceMinutes)} 分钟`,
		);
	}
}

/** `workbench metrics` — three numbers per lane, one number globally. */
export async function metricsCommand(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const [lanes, flow] = await Promise.all([bb.metrics.list(), observeFlow(bb)]);
	if (opts.json) {
		emitJson({ lanes, unreviewedBacklog: flow.unreviewedBacklog });
		return;
	}
	if (opts.quiet) {
		return;
	}
	if (lanes.length === 0) {
		console.log("（还没有车道的用量数据）");
		return;
	}
	console.log("车道用量：绝对 token ／ 缓存命中率 ／ 压缩次数");
	for (const lane of lanes) {
		const tokens =
			lane.absoluteTokens >= 1000
				? `${(lane.absoluteTokens / 1000).toFixed(1)}k`
				: String(lane.absoluteTokens);
		console.log(
			`  ${lane.workspot.padEnd(10)} ${tokens.padStart(8)}  ` +
				`${(lane.cacheHitRate * 100).toFixed(0).padStart(3)}%  ` +
				`×${lane.compactions}` +
				(lane.consecutiveFailures > 0
					? `  连续失败 ${lane.consecutiveFailures}`
					: ""),
		);
	}
	console.log(`未复核积压：${flow.unreviewedBacklog} 项（全局唯一共享的数）`);
}
