/**
 * TF-0137 · 账本的 markdown 呈现。
 *
 * 输出目标是 docs/fit-ledger.md：每周重跑覆盖一次，所以正文里不写任何
 * 手工维护的内容——一切来自 ledger.ts 的推导结果。
 */

import type { ChatStats } from "../../src/chat/stats";
import type { MoatNumber, Row, SampleWindow } from "./ledger";
import type { Fit } from "./metrics";
import type { EvidenceKind, Verdict, VerdictStatus } from "./verdicts";

export interface Report {
	generatedAt: string;
	blackboard: string;
	evidenceKind: EvidenceKind;
	observation: ChatStats["observation"];
	dataQuality: ChatStats["dataQuality"];
	restoreToMessage: ChatStats["lifecycle"]["restoreToMessage"];
	/**
	 * L1 的整个读数块：`current`（新口径）与 `threshold`（旧口径，历史可比）
	 * 必须并报一个周期——口径切换最容易被误读成「指标突然变好/变差」，
	 * 两条并排，变化才归因得到口径而不是产品。
	 */
	landmarkReviews: ChatStats["landmarkReviews"];
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
	verdicts: Verdict[];
	rows: Row[];
}

const EVIDENCE_LABEL: Record<EvidenceKind, string> = {
	unknown: "未声明来源，四项判决保持证据不足",
	scripted: "脚本工程场景",
	"live-model": "真实模型执行，手势与场景由脚本安排",
	natural: "自然使用记录（需核对原始现场）",
};
const VERDICT_LABEL: Record<VerdictStatus, string> = {
	supported: "本现场支持判据",
	"not-supported": "本现场不满足判据",
	"insufficient-evidence": "证据不足",
};

const show = (value: number | string | null): string =>
	value === null ? "无样本" : String(value);

const KIND_LABEL: Record<Row["kind"], string> = {
	component: "部件",
	record: "决策/实验/修复",
	milestone: "里程碑",
	unbuilt: "未开工/缺指标",
};

/**
 * fit 列的显示（issue #13）。`unknown` 有两种来源，对外必须一眼分开：
 * 结构性 unknown 是纪律规定（决策/实验/修复类无指标可引，有书面复核指针），
 * 证据缺口 unknown 是部件建出来了但样本不足或来源不是自然使用。
 * 分类是推导出来的，不是手写的——账本每周重跑覆盖，手写分类会丢。
 */
function fitLabel(row: Row): string {
	if (row.fit !== "unknown") {
		return `\`${row.fit}\``;
	}
	return row.unknownClass === "structural"
		? "`unknown`（结构性）"
		: row.unknownClass === "evidence-gap"
			? "`unknown`（证据缺口）"
			: "`unknown`";
}

export function renderMarkdown(report: Report): string {
	const { histogram, moat, gate, rows } = report;
	const counted = rows.filter((r) => r.kind !== "milestone").length;
	const notNatural =
		report.evidenceKind === "natural"
			? []
			: [
					"> **不是护城河验收。** 来源不是自然使用。下文「本现场支持判据」和「数字闸门开」只描述这份黑板，不能写成产品已验证。",
					"",
				];
	const lines: string[] = [
		"# fit 账本（TF-0137）",
		"",
		"> 本文件由 `bun run scripts/fit-ledger.ts --out ../../docs/fit-ledger.md` 生成，",
		"> 每周重跑覆盖一次。不要手工编辑：手写的结论没有来源，也就不能用于砍留决策。",
		"",
		...notNatural,
		`- 生成时间：${report.generatedAt}`,
		`- 数据源黑板：\`${report.blackboard}\``,
		`- 样本来源（运行者声明）：${EVIDENCE_LABEL[report.evidenceKind]}。该声明不筛选或认证事件，混合现场须单独核对。`,
		`- 事件跨度：${report.observation.days.toFixed(1)} 天（${
			report.observation.startedAt ?? "无"
		} → ${report.observation.endedAt ?? "无"}）。工程窗口不以日历设门；L3 自然使用仍要求至少 14 天。`,
		"",
		"两条纪律（词表与证据）：",
		"",
		"1. fit 只取 task-forest `alignment.fit` 的五个值：`aligned` / `partial` / `weak` / `misaligned` / `unknown`。",
		"2. 无真实使用一律 `unknown`。**测试通过不算使用**，所以「有测试」永远不会把一行推离 `unknown`。",
		"",
		"一条叙事纪律（issue #13）：**`unknown` 不得在对外材料中被表述为 `validated` 或已验证**。",
		"它既不是「通过」也不是「失败」，而是「这行还没有可引用的证据」。结构性 unknown 用记录回答",
		"（见各行的复核指路），证据缺口 unknown 用补样本或换来源回答——两者都不是「已验证」。",
		"下表的 fit 列把两种 unknown 分开标注，就是为了挡住这个误读。",
		"",
		"同一个词表，两种问法，别混：",
		"",
		"- 森林的 `alignment.fit` 问的是**这个任务服不服务用户目标**（先验判断，做之前就能填）。",
		"- 本账本的 fit 问的是**建出来的东西有没有被真的用过**（后验证据，只能等数据）。",
		"",
		"共用词表是为了能互相引用，不是为了互相覆盖：**账本永不写回森林的 `alignment` 字段**。",
		"所以本账本一行是 `unknown` 而同一节点在森林里是 `aligned`，两者不矛盾——前者说没数据，后者说方向对。",
		"",
		"## t0（现场采样起点，TF-0141）",
		"",
		report.t0.started
			? `**已开始**：实测 ${report.t0.threads} 条线程、${report.t0.writers} 个注册写者，部件行按该现场来源计入 fit。`
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
			? "**工程窗口已凑齐**：可以核对四项判据；自然用户效果与 L3 长期门槛仍单独判断。"
			: `**窗口未凑齐**：还差 ${window.missing.join("、")}。凑齐之前结论一律 \`unknown\`，不以测试或日历替代。`,
		"",
	);
	lines.push(
		"## 四项判决（TF-0136）",
		"",
		"仅从本现场提出判断与下一步，不自动修改卡片、谓词或森林状态。",
		"",
	);
	for (const item of report.verdicts) {
		lines.push(
			`### ${item.title}：${VERDICT_LABEL[item.status]}`,
			"",
			item.action,
			"",
			"| 来源 | 实测 | 判据 |",
			"| --- | --- | --- |",
		);
		for (const reading of item.readings) {
			lines.push(
				`| ${reading.source} | ${show(reading.value)} | ${reading.threshold} |`,
			);
		}
		lines.push("");
	}

	const timing = report.restoreToMessage;
	lines.push(
		`## 恢复到首条消息（TF-0126，近 ${timing.windowDays} 天）`,
		"",
		"| 恢复时卡片 | 有效样本 | 中位耗时（ms） |",
		"| --- | --- | --- |",
		`| 可见 | ${timing.withCard.samples} | ${show(timing.withCard.medianMs)} |`,
		`| 不可见 | ${timing.withoutCard.samples} | ${show(timing.withoutCard.medianMs)} |`,
		`| 未记录 | ${timing.unknownCard.samples} | ${show(timing.unknownCard.medianMs)} |`,
		"",
		`未配对恢复：${timing.incomplete}。来源：\`stats.lifecycle.restoreToMessage\`；恢复事件与当次加载后的第一条用户消息配对，切走即结束。`,
		"",
		timing.medianChangeRatio === null
			? "**比较 unknown**：缺少可比较样本或无卡中位数为零，不能判定 20% 门槛。"
			: `中位耗时差异：${(timing.medianChangeRatio * 100).toFixed(1)}%；超过 20%：${timing.exceeds20Percent ? "是" : "否"}。这是观察值，不证明卡片导致变化，不自动改变卡片或节点状态。`,
		"",
	);

	if (report.dataQuality.insufficientHistory) {
		lines.push("## 数据质量：insufficient-history", "");
		for (const reason of report.dataQuality.reasons) {
			lines.push(`- ${reason}`);
		}
		lines.push("");
	}
	const {
		current: landmarks,
		threshold,
		steward,
		coverage,
		unfiltered,
	} = report.landmarkReviews;
	const pct = (value: number | null): string =>
		value === null
			? "无样本（分母为空 → 不可计算）"
			: `${(value * 100).toFixed(1)}%`;
	lines.push(
		"## 地标集合认可（L1）",
		"",
		`- **新口径 \`${landmarks.denominator}\`**（每会话文件级 top-${landmarks.topK}，叠加种类门 + 「只认可落笔」过滤，requireEdits ${landmarks.requireEdits}）：当前候选 ${landmarks.total} 个，已复核 ${landmarks.reviewed} 个，认可 ${landmarks.endorsed} 个，不认可 ${landmarks.rejected} 个。`,
		`  - 完整集合认可率 ${pct(landmarks.endorsedShare)}；复核覆盖率 ${pct(landmarks.reviewedCoverage)}。`,
		`- **旧口径 \`${threshold.denominator}\`**（DOI>10 的文件级集合，历史可比）：当前地标 ${threshold.total} 个，已复核 ${threshold.reviewed} 个，认可 ${threshold.endorsed} 个 → 认可率 ${pct(threshold.endorsedShare)}，复核覆盖 ${pct(threshold.reviewedCoverage)}。`,
		`- **未过滤对照 \`requireEdits: false\`**（翻默认前的旧定义）：当前候选 ${unfiltered.total} 个，已复核 ${unfiltered.reviewed} 个，认可 ${unfiltered.endorsed} 个 → 认可率 ${pct(unfiltered.endorsedShare)}。与第一条的差距即被过滤的纯浏览噪声（2026-09-11 翻默认，对照并报一个周期）。`,
		`- 相对选择的可计量性：有文件级触碰的会话 ${coverage.sessions} 个，其中排得出非空 top-${coverage.k} 的 ${coverage.withSet} 个（覆盖 ${pct(coverage.share)}，条目 ${coverage.items} 条，去重 handle ${coverage.distinctHandles} 个）。`,
		`- 种类门排除 git/human 写者 ${landmarks.gatedWriters} 个（记录的是「文件被动过」，不是「这次干的活是什么」）。`,
		`- 代理自审口径（真实数据，但**不构成用户认可**）：候选 ${steward.total} 个，已复核 ${steward.reviewed} 个，认可率 ${pct(steward.endorsedShare)}。`,
		`- 结论连续性：落在当前集合之外的旧结论 ${landmarks.legacyReviews} 条记为 legacy——**保留、不改判**；口径漂移不是数据丢失。`,
		"",
		"**为什么有两把尺子**：旧口径要求「同一条 handle 在衰减窗口内被推过 10 分」，而真实形状是很多文件各被碰一两次（权重 1–2），跨四个现场实测门后有**三个直接是空集**——分母空了，判据不是 0 分而是**不可计算**。新口径是**换定义**，不是修 bug；双读数期两条并排，满一个周期后再撤旧的那条。",
		"",
		"来源：`stats.landmarkReviews.current`（新，含只认可落笔过滤）/ `.threshold`（旧阈值）/ `.unfiltered`（未过滤对照）/ `.coverage`。分母包含未复核条目；每个写者的每个条目只取最新结论，重复反馈不累加成认可率。",
		"",
	);
	if (report.evidenceKind !== "natural" && landmarks.reviewed > 0) {
		lines.push(
			`本现场来源为「${EVIDENCE_LABEL[report.evidenceKind]}」：复核手势由脚本或模型运行安排，读数只会收敛到脚本里的认可概率，不构成用户认可。TF-0154 行的 fit 因此停在 \`unknown\`；上面的数字只用于核对通道与覆盖率。`,
			"",
		);
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
			? "**数字闸门开：** 四个数字齐备，可以整理与本现场来源相符的 stale-premise benchmark；工程记录不能据此声称自然用户效果。"
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
		const disposition = r.disposition ? `；处置：${r.disposition}` : "";
		lines.push(
			`| ${r.id} ${r.title} | ${KIND_LABEL[r.kind]} | ${r.status} | ${fitLabel(
				r,
			)} | ${r.metric} | ${show(r.value)} | ${trace}${disposition} |`,
		);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}
