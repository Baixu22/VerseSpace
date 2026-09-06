import type { Command } from "commander";
import { type ChatStats, collectChatStats } from "../chat/stats";
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
	// TF-0149: the ratio and its verdict always print. An out-of-band ratio
	// that only lives in --json is the same thing as staying silent.
	const premises = stats.premises;
	console.log(
		`前提谓词：${premises.passes} 个 pass，重叠 ${premises.overlaps}，通知 ${premises.notified}` +
			`（第 1 层 ${premises.suppressedL1} / 第 2 层 ${premises.suppressedL2} / 第 3 层 ${premises.suppressedL3} / 去重 ${premises.suppressedDedup}）`,
	);
	console.log(`  ${premises.advice}`);
	if (premises.passes > 0 && !premises.l3EverSuppressed) {
		console.log("  第 3 层至今从未抑制过任何一条：去留判据见 TF-0136 判决四。");
	}
	// TF-0134: hits vs. what was let through. A seal whose blocks are invisible
	// cannot be judged correct or incorrect.
	const seal = stats.seal;
	console.log(
		`封印：${seal.decisions} 次决策，命中 ${seal.hits}（阻断 ${seal.blocked}，放行 ${seal.hitsAllowed}，其中警告 ${seal.warned}），未命中放行 ${seal.passed}`,
	);
	if (seal.downgraded > 0) {
		console.log(
			`  其中 ${seal.downgraded} 次在连续阻断后自动降级为 warn（seal.consecutiveBlockLimit）。`,
		);
	}
	// 校准闭环（护城河 C 的「正确」腿）：block 只证明拒绝发生过，人工复核
	// 才能说它对不对——未复核的 block 必须以数字露出来，不能沉默。
	if (seal.blocked > 0) {
		const unreviewed = seal.blocked - seal.reviews.total;
		console.log(
			`  封印复核：正确 ${seal.reviews.correct} / 错误 ${seal.reviews.incorrect}` +
				(unreviewed > 0 ? `（未复核 ${unreviewed}）` : ""),
		);
	}
	printCalibrationTable(stats.noticeOutcomes);
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

/**
 * Terminal columns a string occupies. CJK and full-width punctuation are two
 * cells wide, so `padEnd` (which counts code points) misaligns any table that
 * mixes them with ASCII — which is every table in this CLI.
 */
function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
}

function padCell(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * The calibration table (TF-0148): agent结局 beside 人侧动作, so the two
 * channels can be compared by eye rather than by scrolling between two
 * separate summaries.
 */
function printCalibrationTable(outcomes: ChatStats["noticeOutcomes"]): void {
	const { agent, human } = outcomes;
	console.log(
		`校准表：${outcomes.rows} 行（agent 结局 ${agent.delivered} / 人侧动作 ${human.actions + human.notesConsumed}）`,
	);
	const left: Array<[string, number]> = [
		["repaired 已修补", agent.repaired],
		["ignored 未读直改", agent.ignored],
		["sealed 被封印", agent.sealed],
		["dismissed 未再触碰", agent.dismissed],
		["unknown 无法判定", agent.unknown],
	];
	const right: Array<[string, number]> = [
		["笔记被消费", human.notesConsumed],
		["卡片被 dismiss", human.dismissed],
		["恢复动作合计", human.actions],
	];
	const cells = left.map(([label, count]) => `${label} ${count}`);
	const column = Math.max(...cells.map(displayWidth)) + 2;
	const rows = Math.max(left.length, right.length);
	for (let index = 0; index < rows; index += 1) {
		const h = right[index];
		const rightCell = h ? `${h[0]} ${h[1]}` : "";
		console.log(`  ${padCell(cells[index] ?? "", column)}│ ${rightCell}`);
	}
	// ignored is the dangerous state: it never hides inside the aggregate.
	if (agent.ignored > 0) {
		console.log(
			`  ⚠ ignored ${agent.ignored} 条（未重读就直接改）：判决二要求 ignored / notified ≤ 0.1，当前 ${outcomes.ignoredRatio}。`,
		);
	}
	if (agent.unknown > 0) {
		const by = agent.unknownBy;
		console.log(
			`  unknown 拆分：不可观测 ${by.unobservable} / 尚无后续活动 ${by["no-later-activity"]} / 路径无法还原 ${by["unresolved-paths"]}`,
		);
	}
}
