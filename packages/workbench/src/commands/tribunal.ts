import type { Command } from "commander";
import { emitJson, type GlobalOptions } from "../output";
import {
	CRITICAL_SHARE_LIMIT,
	effectiveState,
	RATE_LIMIT_PER_HOUR,
} from "../tribunal/queue";
import { explainGrading } from "../tribunal/rationalize";
import type { TribunalItem, TribunalPriority } from "../types/tribunal";
import { resolveBlackboard } from "./context";

/**
 * The human side of the adjudication queue (R3 / TF-0081, TF-0082).
 *
 * Two rules shape everything here:
 * - the human channel is BINARY. An item is either pushed or it is not; there
 *   is no "warning" level between "shut up" and "interrupt me". A graded
 *   likelihood display loses to a conservative threshold on both sensitivity
 *   and misses, and it cannot produce a wolf-cry effect. The SLA label
 *   (critical → low) is how SOON an answer is owed, not how sure we are.
 * - every card ends in a recommendation. A card that ends in a question asks
 *   the human to do reasoning the machine already did.
 */

const PRIORITY_LABEL: Record<TribunalPriority, string> = {
	critical: "紧急",
	high: "高",
	medium: "中",
	low: "低",
};

const STATE_LABEL: Record<TribunalItem["state"], string> = {
	pending: "待裁决",
	shelved: "已推迟",
	resolved: "已裁决",
	expired: "已过期",
};

/** One card: SBAR, then the action, then why it was graded this way. */
export function renderCard(item: TribunalItem): string[] {
	const lines: string[] = [];
	const push = item.push ? "推送" : "静默（只进队列，不打扰）";
	lines.push(
		`${item.id} [${PRIORITY_LABEL[item.priority]}/${STATE_LABEL[item.state]}] ${push} · ${item.kind}`,
	);
	lines.push(`  对象：${item.subject}`);
	lines.push(`  S 现状 ${item.sbar.situation}`);
	lines.push(`  B 背景 ${item.sbar.background}`);
	lines.push(`  A 后果 ${item.sbar.assessment}`);
	lines.push(`  R 建议 ${item.sbar.recommendation}`);
	lines.push(`  动作：${item.action.label}`);
	if (item.action.command) {
		lines.push(`        $ ${item.action.command}`);
	}
	lines.push(`  分级：${explainGrading(item)}`);
	if (item.escalated && item.escalationReason) {
		lines.push(`  越级：${item.escalationReason}`);
	}
	if (item.folded.length > 0) {
		const last = item.folded[item.folded.length - 1];
		lines.push(
			`  折叠：${item.folded.length} 条同源事件（最近 ${last?.subject} @ ${last?.at}）`,
		);
	}
	if (item.shelveCount > 0) {
		lines.push(`  推迟过 ${item.shelveCount} 次`);
	}
	return lines;
}

export async function tribunalListCommand(
	options: { all?: boolean; push?: boolean } = {},
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const items =
		options.push === true
			? await bb.tribunal.pushable()
			: await bb.tribunal.list({ includeResolved: options.all === true });
	if (opts.json) {
		emitJson({ tribunal: items });
		return;
	}
	if (opts.quiet) {
		return;
	}
	if (items.length === 0) {
		console.log(
			options.push === true ? "（没有需要打断你的事）" : "（队列是空的）",
		);
		return;
	}
	for (const item of items) {
		for (const line of renderCard(item)) {
			console.log(line);
		}
		console.log("");
	}
}

export async function tribunalShowCommand(
	options: { id: string },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const item = await bb.tribunal.get(options.id);
	if (!item) {
		throw new Error(`队列里没有这一条：${options.id}`);
	}
	if (opts.json) {
		emitJson(item);
		return;
	}
	if (opts.quiet) {
		return;
	}
	for (const line of renderCard(item)) {
		console.log(line);
	}
}

export async function tribunalShelveCommand(
	options: { id: string; minutes?: string },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const minutes = Number(options.minutes ?? 30) || 30;
	const item = await bb.tribunal.shelve(options.id, minutes);
	if (!item) {
		throw new Error(`队列里没有可推迟的条目：${options.id}`);
	}
	if (opts.json) {
		emitJson(item);
		return;
	}
	if (opts.quiet) {
		return;
	}
	console.log(
		`已推迟 ${item.id} 至 ${item.shelvedUntil}（第 ${item.shelveCount} 次推迟）`,
	);
}

export async function tribunalResolveCommand(
	options: { id: string },
	command: Command,
): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const item = await bb.tribunal.resolve(options.id);
	if (!item) {
		throw new Error(`队列里没有可裁决的条目：${options.id}`);
	}
	if (opts.json) {
		emitJson(item);
		return;
	}
	if (opts.quiet) {
		return;
	}
	console.log(`已裁决 ${item.id}（保留在磁盘上作为证据，一周后清理）`);
}

export async function tribunalStatsCommand(command: Command): Promise<void> {
	const opts = command.optsWithGlobals() as GlobalOptions;
	const bb = await resolveBlackboard();
	const [stats, distribution] = await Promise.all([
		bb.tribunal.stats(),
		bb.tribunal.distribution(),
	]);
	const payload = { ...stats, distribution };
	if (opts.json) {
		emitJson(payload);
		return;
	}
	if (opts.quiet) {
		return;
	}
	console.log(
		`队列：待裁决 ${stats.open} · 已推迟 ${stats.shelved} · 需推送 ${stats.pushable}`,
	);
	console.log(
		`分级分布：紧急 ${distribution.critical} / 高 ${distribution.high} / 中 ${distribution.medium} / 低 ${distribution.low}（共 ${distribution.total}）`,
	);
	console.log(
		`24 小时：入队 ${stats.admitted24h} · 已裁决 ${stats.resolved24h} · 速率 ${stats.ratePerHour.toFixed(2)}/小时（预算 ${RATE_LIMIT_PER_HOUR}）`,
	);
	console.log(
		`洪泛：${stats.flood ? `是（10 分钟内 ${stats.floodCount} 条）` : "否"}` +
			` · 严重项占比 ${(stats.criticalShare * 100).toFixed(0)}%（上限 ${CRITICAL_SHARE_LIMIT * 100}%）`,
	);
	console.log(
		stats.rationalizationOk
			? "合理化：分级健康"
			: "合理化：严重项过多 —— 是分级失败，不是业务真的这么糟",
	);
	if (!stats.distributionOk) {
		console.log("分布：不接近 5/15/30/50 —— 再查分级，别把所有东西都标紧急");
	}
	if (stats.shelves > 0) {
		console.log(
			`推迟次数合计 ${stats.shelves} —— 队列被反复推迟说明分级不对，不是事情太多`,
		);
	}
}

/** Re-exported so the UI and the CLI never disagree about a lapsed deferral. */
export { effectiveState };
