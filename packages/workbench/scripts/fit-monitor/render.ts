/**
 * TF-0135 / TF-0136 / TF-0137 · 监控报告渲染。
 *
 * 报告只复述机读产物：每个数字后面跟的是它从哪来。理由和账本一样——手写的
 * 结论没有来源，也就不能用于砍留决策；监控报告还多一条，它要能被上一份报告
 * 逐项对照，所以趋势表列的是同一批字段。
 */

import {
	type Alert,
	type MonitorSample,
	SEVERITY_RANK,
	type Severity,
} from "./types";

const LABEL: Record<Severity, string> = {
	high: "必须处理",
	warn: "留意",
	info: "长期项",
};

const fmt = (value: number | null, digits = 4): string =>
	value === null ? "无样本" : Number(value.toFixed(digits)).toString();

const cell = (value: string): string => value.replace(/\|/g, "/");

export function renderMonitorReport(options: {
	samples: MonitorSample[];
	alerts: Alert[];
	current: MonitorSample;
	title?: string;
}): string {
	const { samples, alerts, current } = options;
	const lines: string[] = [];
	lines.push(`# fit 数据监控（TF-0135 / TF-0136 / TF-0137）`);
	lines.push("");
	lines.push(
		`> ${options.title ?? "由 `bun scripts/fit-monitor.ts` 生成，只读采样，不改黑板与森林。"}`,
	);
	lines.push("");
	lines.push(`- 生成时间：${current.at}`);
	lines.push(
		`- 现场：\`${current.workspace}\` · 黑板 \`${current.blackboard}\``,
	);
	lines.push(
		`- 来源声明：\`${current.evidenceKind}\`（声明只决定哪些结论允许被推动，不筛选事件）`,
	);
	lines.push(
		`- 事件跨度：${current.days.toFixed(2)} 天（只作长期观察记录；TF-0141 已把工程门从日历改为样本量）`,
	);
	lines.push(
		`- 跑次：累计 ${current.rounds.total}（成功 ${current.rounds.ok} / 失败 ${current.rounds.failed}）· 模型调用 ${current.model.calls} 次 / 尝试 ${current.model.attempts} 次（重试率 ${(current.model.retryRate * 100).toFixed(2)}%）`,
	);
	lines.push("");

	lines.push("## 告警");
	lines.push("");
	if (alerts.length === 0) {
		lines.push("无告警：门槛齐备且与上一份样本一致。");
	} else {
		const ranked = [...alerts].sort(
			(a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
		);
		lines.push("| 级别 | 项 | 说明 | 证据 |");
		lines.push("| --- | --- | --- | --- |");
		for (const alert of ranked)
			lines.push(
				`| ${LABEL[alert.severity]} | ${cell(alert.title)} | ${cell(alert.detail)} | ${cell(alert.evidence)} |`,
			);
	}
	lines.push("");

	lines.push("## 门槛状态");
	lines.push("");
	lines.push("| 判据 | 实测 | 结果 |");
	lines.push("| --- | --- | --- |");
	lines.push(
		`| t0（线程 > 0 且写者 > 0） | ${current.threads} 线程 / ${current.writers} 写者 | ${current.t0Started ? "已开始" : "未开始"} |`,
	);
	lines.push(
		`| 样本窗口 restores ≥ ${current.sampleWindow.targets.restores} | ${current.sampleWindow.restores} | ${current.sampleWindow.satisfied ? "齐" : "未齐"} |`,
	);
	lines.push(
		`| 样本窗口 noticeOutcomes ≥ ${current.sampleWindow.targets.noticeOutcomes} | ${current.sampleWindow.noticeOutcomes} | ${current.sampleWindow.satisfied ? "齐" : "未齐"} |`,
	);
	lines.push(
		`| 样本窗口 sealDecisions ≥ ${current.sampleWindow.targets.sealDecisions} | ${current.sampleWindow.sealDecisions} | ${current.sampleWindow.satisfied ? "齐" : "未齐"} |`,
	);
	lines.push(
		`| benchmark 闸门 | ${current.gate.open ? "开" : `关（缺 ${current.gate.missing.join("、")}）`} | ${current.gate.open ? "齐备" : "缺项"} |`,
	);
	lines.push("");

	lines.push("## 四项判决");
	lines.push("");
	lines.push("| 判决 | 状态 |");
	lines.push("| --- | --- |");
	for (const verdict of current.verdicts)
		lines.push(`| ${cell(verdict.title)} | \`${verdict.status}\` |`);
	lines.push("");

	lines.push("## 护城河四数字（TF-0137 验收六）");
	lines.push("");
	lines.push("| 数字 | 门槛 | 实测 | 齐 |");
	lines.push("| --- | --- | --- | --- |");
	for (const number of current.moat)
		lines.push(
			`| ${number.key} ${cell(number.name)} | ${cell(number.threshold)} | ${typeof number.value === "number" ? fmt(number.value) : (number.value ?? "无样本")} | ${number.present ? "是" : "否"} |`,
		);
	lines.push("");

	lines.push("## fit 分布与 unknown 构成");
	lines.push("");
	lines.push(
		`aligned ${current.histogram.aligned} · partial ${current.histogram.partial} · weak ${current.histogram.weak} · misaligned ${current.histogram.misaligned} · unknown ${current.histogram.unknown}（合计 ${current.histogram.aligned + current.histogram.partial + current.histogram.weak + current.histogram.misaligned + current.histogram.unknown} 行，里程碑不计）`,
	);
	lines.push("");
	lines.push(
		`unknown ${current.unknown.total} = 决策/实验/修复类 ${current.unknown.record} + 无样本部件 ${current.unknown.noSample} + 未指定指标 ${current.unknown.unbuilt} + 人类认可未到位 ${current.unknown.natural}`,
	);
	if (current.unknown.ids.length > 0)
		lines.push(`\n清单：${current.unknown.ids.join("、")}`);
	lines.push("");

	lines.push("## 趋势");
	lines.push("");
	lines.push(
		"| 采样时间 | 线程 | 写者 | 恢复 | 通知 | 封印 | 闸门 | 判决 1/2/3 | unknown | L1 认可率 | 调用/尝试 |",
	);
	lines.push(
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	);
	for (const sample of samples.slice(-12)) {
		const statuses = sample.verdicts
			.filter((verdict) => verdict.id !== "l3")
			.map((verdict) =>
				verdict.status === "supported"
					? "✓"
					: verdict.status === "not-supported"
						? "✗"
						: "?",
			)
			.join("/");
		lines.push(
			`| ${sample.at.slice(0, 19).replace("T", " ")} | ${sample.threads} | ${sample.writers} | ${sample.sampleWindow.restores} | ${sample.sampleWindow.noticeOutcomes} | ${sample.sampleWindow.sealDecisions} | ${sample.gate.open ? "开" : "关"} | ${statuses} | ${sample.histogram.unknown} | ${fmt(sample.natural.endorsedShare, 3)} | ${sample.model.calls}/${sample.model.attempts} |`,
		);
	}
	lines.push("");

	lines.push("## 监控边界");
	lines.push("");
	lines.push(
		"- 监控不写黑板、不改森林状态：样本只读，告警只报告。这样差分判断才有可信度。",
	);
	lines.push(
		"- 自然使用类指标（L1 认可率、恢复卡人类耗时）不可能由脚本或模型生成；监控只负责把它们变成「待办数量 + 一条命令」，不负责替人回答。",
	);
	lines.push(
		"- 日历窗口（14 天 / 30 天）按 TF-0141 只作长期观察记录，不作为工程推进的门。",
	);
	lines.push("");
	return `${lines.join("\n")}\n`;
}
