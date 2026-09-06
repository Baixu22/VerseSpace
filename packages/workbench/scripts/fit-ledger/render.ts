/**
 * TF-0137 · 账本的 markdown 呈现。
 *
 * 输出目标是 docs/fit-ledger.md：每周重跑覆盖一次，所以正文里不写任何
 * 手工维护的内容——一切来自 ledger.ts 的推导结果。
 */

import type { ChatStats } from "../../src/chat/stats";
import type { MoatNumber, Row, SampleWindow } from "./ledger";
import type { Fit } from "./metrics";

export interface Report {
	blackboard: string;
	observation: ChatStats["observation"];
	dataQuality: ChatStats["dataQuality"];
	/** TF-0141 的 t0 判据实测：有真实线程，且注册过写者。 */
	t0: { started: boolean; threads: number; writers: number };
	/** TF-0141 样本窗口（2026-09-06 重设计）：裁决看样本量，不看日历。 */
	sampleWindow: SampleWindow;
	/** TF-0149 近窗伴随读数：聚合比值随空闲 dedup 自然衰减，窗口读数防衰减。 */
	premisesRecent: {
		windowDays: number;
		passes: number;
		overlaps: number;
		notified: number;
		ratio: number | null;
	};
	histogram: Record<Fit, number>;
	moat: MoatNumber[];
	gate: { open: boolean; missing: string[] };
	rows: Row[];
}

const show = (value: number | string | null): string =>
	value === null ? "无样本" : String(value);

const KIND_LABEL: Record<Row["kind"], string> = {
	component: "部件",
	record: "决策/实验/修复",
	milestone: "里程碑",
	unbuilt: "未开工/缺指标",
};

export function renderMarkdown(report: Report): string {
	const { histogram, moat, gate, rows } = report;
	const counted = rows.filter((r) => r.kind !== "milestone").length;
	const lines: string[] = [
		"# fit 账本（TF-0137）",
		"",
		"> 本文件由 `bun run scripts/fit-ledger.ts --out ../../docs/fit-ledger.md` 生成，",
		"> 每周重跑覆盖一次。不要手工编辑：手写的结论没有来源，也就不能用于砍留决策。",
		"",
		`- 生成时间：${new Date().toISOString()}`,
		`- 数据源黑板：\`${report.blackboard}\``,
		`- 事件跨度：${report.observation.days.toFixed(1)} 天（${
			report.observation.startedAt ?? "无"
		} → ${report.observation.endedAt ?? "无"}）。跨度只是信息项，不做门槛。`,
		"",
		"两条纪律（词表与证据）：",
		"",
		"1. fit 只取 task-forest `alignment.fit` 的五个值：`aligned` / `partial` / `weak` / `misaligned` / `unknown`。",
		"2. 无真实使用一律 `unknown`。**测试通过不算使用**，所以「有测试」永远不会把一行推离 `unknown`。",
		"",
		"同一个词表，两种问法，别混：",
		"",
		"- 森林的 `alignment.fit` 问的是**这个任务服不服务用户目标**（先验判断，做之前就能填）。",
		"- 本账本的 fit 问的是**建出来的东西有没有被真的用过**（后验证据，只能等数据）。",
		"",
		"共用词表是为了能互相引用，不是为了互相覆盖：**账本永不写回森林的 `alignment` 字段**。",
		"所以本账本一行是 `unknown` 而同一节点在森林里是 `aligned`，两者不矛盾——前者说没数据，后者说方向对。",
		"",
		"## t0（日用起点，TF-0141）",
		"",
		report.t0.started
			? `**已开始**：实测 ${report.t0.threads} 条真实线程、${report.t0.writers} 个注册写者，部件行的实测值开始计入 fit。`
			: `**未开始**：实测 ${report.t0.threads} 条线程、${report.t0.writers} 个注册写者。` +
				"t0 之前 `events.jsonl` 里是自举期数据，所有部件行强制停在 `unknown`——" +
				"下面的「当前值」照常显示，但不推动 fit。",
		"",
	];

	const window = report.sampleWindow;
	lines.push(
		"## 样本窗口（TF-0141）",
		"",
		"| 样本类别 | 实测 | 目标 | 齐 |",
		"| --- | --- | --- | --- |",
		`| 恢复周期 lifecycle.restores | ${window.restores} | ${window.targets.restores} | ${window.restores >= window.targets.restores ? "是" : "**否**"} |`,
		`| 通知结局 noticeOutcomes.rows | ${window.noticeOutcomes} | ${window.targets.noticeOutcomes} | ${window.noticeOutcomes >= window.targets.noticeOutcomes ? "是" : "**否**"} |`,
		`| 封印判决 seal.decisions | ${window.sealDecisions} | ${window.targets.sealDecisions} | ${window.sealDecisions >= window.targets.sealDecisions ? "是" : "**否**"} |`,
		"",
		window.satisfied
			? "**窗口已凑齐**：TF-0136 / TF-0135 可以按既定门槛裁决——看样本，不看日历。"
			: `**窗口未凑齐**：还差 ${window.missing.join("、")}。凑齐之前结论一律 \`unknown\`，不以测试或日历替代。`,
		"",
	);

	if (report.dataQuality.insufficientHistory) {
		lines.push("## 数据质量：insufficient-history", "");
		for (const reason of report.dataQuality.reasons) {
			lines.push(`- ${reason}`);
		}
		lines.push("");
	}

	lines.push(
		"## 护城河四个数字（样本齐备后回看）",
		"",
		"| | 数字 | 门槛 | 当前 | 齐备 | 来源 |",
		"| --- | --- | --- | --- | --- | --- |",
	);
	for (const m of moat) {
		lines.push(
			`| ${m.key} | ${m.name} | ${m.threshold} | ${show(m.value)} | ${
				m.present ? "是" : "**否**"
			} | \`${m.source}\` |`,
		);
	}
	lines.push("");
	lines.push(
		gate.open
			? "**闸门开：** 四个数字齐备，可以开始写对外的 stale-premise benchmark。"
			: `**闸门关：** 缺 ${gate.missing.join("、")}。缺任何一个先补它，不扩树。`,
		"",
	);
	if (report.premisesRecent.passes > 0) {
		const recent = report.premisesRecent;
		const pct =
			recent.ratio === null ? "无样本" : `${(recent.ratio * 100).toFixed(1)}%`;
		lines.push(
			`> 近 ${recent.windowDays} 天窗口读数：notified/overlaps = ${pct}（${recent.overlaps} 次重叠 / ${recent.passes} 轮）。聚合比值随空闲重查的 dedup 累积自然衰减，窗口读数反映当前谓词健康度；聚合口径与 band 判定不变。`,
			"",
		);
	}

	lines.push(
		"## fit 分布",
		"",
		`计入 fit 的节点 ${counted} 个（里程碑不计，deprecated 不入账也不进分母）：`,
		"",
		`- aligned ${histogram.aligned} · partial ${histogram.partial} · weak ${histogram.weak} · misaligned ${histogram.misaligned} · **unknown ${histogram.unknown}**`,
		"",
	);

	lines.push(
		"## 逐节点",
		"",
		"| 节点 | 类型 | 状态 | fit | 可观测指标（authored） | 当前值（measured） | 依据 |",
		"| --- | --- | --- | --- | --- | --- | --- |",
	);
	for (const r of rows) {
		const trace = r.trace ? `${r.why}；复核指路：${r.trace}` : r.why;
		lines.push(
			`| ${r.id} ${r.title} | ${KIND_LABEL[r.kind]} | ${r.status} | \`${r.fit}\` | ${
				r.metric
			} | ${show(r.value)} | ${trace} |`,
		);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}
