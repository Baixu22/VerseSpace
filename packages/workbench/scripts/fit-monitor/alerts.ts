/**
 * TF-0135 / TF-0136 / TF-0137 · 告警规则。
 *
 * 规则是纯函数：吃两次快照，吐告警。之所以不做「自动修」，是因为监控一旦能改
 * 被观测对象，它就同时成了运动员和裁判——上一轮账本纠正 L1 读数时已经证明，
 * 有价值的部分恰恰是「值照常显示、结论不跟着动」。
 *
 * 严重度三级：
 *   high  数据丢了 / 门槛掉了 / 跑挂了：工程上必须立刻处理；
 *   warn  方向不对但还没越线，或者口径与文档对不上；
 *   info  设计上就该现在这样的长期项（日历窗口、等自然使用的队列），
 *         记下来是为了不被忘记，不是因为它是故障。
 */

import type { Alert, MonitorSample } from "./types";

const fmt = (value: number | null, digits = 4): string =>
	value === null ? "无样本" : Number(value.toFixed(digits)).toString();

const ERROR_OUTCOMES = [
	"request-error",
	"http-error",
	"invalid-response",
	"invalid-json",
	"empty-stop",
] as const;

export function evaluateAlerts(
	previous: MonitorSample | null,
	current: MonitorSample,
): Alert[] {
	const alerts: Alert[] = [];
	const push = (alert: Alert): void => {
		alerts.push(alert);
	};

	if (!current.t0Started) {
		push({
			id: "t0-not-started",
			severity: "high",
			title: "t0 未开始：没有真实线程或没有注册写者",
			detail: "账本所有部件行会被强制停在 unknown，采样等于没开始。",
			evidence: `threads=${current.threads} writers=${current.writers}`,
		});
		if (previous?.t0Started)
			push({
				id: "t0-lost",
				severity: "high",
				title: "t0 从「已开始」退回「未开始」",
				detail: "采样起点消失通常意味着黑板被清空或指向了另一个目录。",
				evidence: `${previous.threads}→${current.threads} 线程，${previous.writers}→${current.writers} 写者`,
			});
	}

	if (!current.sampleWindow.satisfied)
		push({
			id: "window-unsatisfied",
			severity: "high",
			title: "样本窗口未凑齐",
			detail: "结论会退回 insufficient-history，四项判决无法判。",
			evidence: `缺：${current.sampleWindow.missing.join("、") || "—"}`,
		});

	if (previous) {
		const regressed = (
			[
				[
					"恢复周期",
					previous.sampleWindow.restores,
					current.sampleWindow.restores,
				],
				[
					"通知结局",
					previous.sampleWindow.noticeOutcomes,
					current.sampleWindow.noticeOutcomes,
				],
				[
					"封印判决",
					previous.sampleWindow.sealDecisions,
					current.sampleWindow.sealDecisions,
				],
			] as const
		).filter(([, before, after]) => after < before);
		if (regressed.length > 0)
			push({
				id: "window-regression",
				severity: "high",
				title: "样本窗口计数倒退（数据丢失或样本源换了）",
				detail: "累积样本只应单调增；倒退说明黑板被重写或监控指错了现场。",
				evidence: regressed
					.map(([name, before, after]) => `${name} ${before}→${after}`)
					.join("；"),
			});

		const flipped = current.verdicts.filter((verdict) => {
			const before = previous.verdicts.find((item) => item.id === verdict.id);
			return before?.status === "supported" && verdict.status !== "supported";
		});
		if (flipped.length > 0)
			push({
				id: "verdict-regression",
				severity: "high",
				title: "已 supported 的判决掉出门槛",
				detail: "门槛没变、读数变差，是要修的回归而不是要解释的噪声。",
				evidence: flipped
					.map((verdict) => `${verdict.title} supported→${verdict.status}`)
					.join("；"),
			});

		const lostMoat = current.moat.filter((number) => {
			const before = previous.moat.find((item) => item.key === number.key);
			return before?.present === true && !number.present;
		});
		if (lostMoat.length > 0)
			push({
				id: "moat-regression",
				severity: "high",
				title: "护城河数字从齐备掉成缺项",
				detail: "benchmark 闸门会随之关闭，缺哪个先补哪个。",
				evidence: lostMoat
					.map((number) => `${number.key} ${number.name}`)
					.join("；"),
			});

		if (current.rounds.failed > previous.rounds.failed)
			push({
				id: "round-failures",
				severity: "high",
				title: "本轮批次有跑次失败",
				detail:
					"失败的跑次会留下半程现场；先看 runs/report-*.json 的失败步骤。",
				evidence: `失败跑次 ${previous.rounds.failed}→${current.rounds.failed}（累计 ${current.rounds.total} 轮）`,
			});

		if (
			current.rounds.total === previous.rounds.total &&
			current.threads === previous.threads &&
			current.writers === previous.writers &&
			current.sampleWindow.restores === previous.sampleWindow.restores
		)
			push({
				id: "sampling-stalled",
				severity: "warn",
				title: "两次采样之间没有任何累积",
				detail:
					"既没有新跑次也没有新线程，监控在空转；要么补跑次，要么把采样间隔拉开。",
				evidence: `rounds=${current.rounds.total} threads=${current.threads}`,
			});

		const unknownDelta = current.histogram.unknown - previous.histogram.unknown;
		const componentDelta = current.unknown.noSample - previous.unknown.noSample;
		const recordDelta = current.unknown.record - previous.unknown.record;
		if (unknownDelta > 0 && componentDelta >= 0 && recordDelta >= 0)
			push({
				id: "unknown-drift",
				severity: "warn",
				title: "unknown 行数上升",
				detail:
					"账本验收一是 unknown 下降；上升要能解释成口径（新节点入 scope）还是退步（部件没数据）。",
				evidence: `unknown ${previous.histogram.unknown}→${current.histogram.unknown}（决策/实验类 ${previous.unknown.record}→${current.unknown.record}，无样本部件 ${previous.unknown.noSample}→${current.unknown.noSample}）`,
			});
	}

	if (current.gate.open === false)
		push({
			id: "gate-closed",
			severity: "high",
			title: "benchmark 闸门关闭",
			detail: "四个数字缺一不开；缺哪个先补它，不扩树。",
			evidence: `缺：${current.gate.missing.join("、") || "—"}`,
		});

	if (current.model.retryRate > 0.05)
		push({
			id: "retry-rate",
			severity: "warn",
			title: "模型调用重试率超过 5%",
			detail:
				"有界重试本身是设计；超过阈值说明上游稳定性在拖慢采样，值得记一笔。",
			evidence: `${current.model.attempts} 次尝试 / ${current.model.calls} 次调用 = ${(current.model.retryRate * 100).toFixed(2)}%`,
		});

	const errorOutcomes = ERROR_OUTCOMES.filter(
		(outcome) => (current.model.outcomes[outcome] ?? 0) > 0,
	);
	if (errorOutcomes.length > 0)
		push({
			id: "model-error-outcomes",
			severity: "info",
			title: "模型层出现过可恢复错误",
			detail:
				"这些错误若无跑次失败，说明有界重试兜住了；记录是为了看它是否在变密。",
			evidence: errorOutcomes
				.map((outcome) => `${outcome}×${current.model.outcomes[outcome]}`)
				.join("、"),
		});

	if (current.dataQuality.insufficientHistory)
		push({
			id: "data-quality",
			severity: "warn",
			title: "stats 自报 insufficient-history",
			detail: "以本现场数据下结论会被 stats 自己拒绝。",
			evidence: current.dataQuality.reasons.join("、") || "—",
		});

	if (current.restoreToMessage.exceeds20Percent === true)
		push({
			id: "restore-latency",
			severity: "warn",
			title: "恢复到首条消息的中位耗时超过 +20%",
			detail:
				"本项由脚本手势驱动（恢复后先断言卡再发消息），不能当人类耗时证据；只作为「卡变重了」的工程信号。",
			evidence: `withCard 样本 ${current.restoreToMessage.samples}，medianChangeRatio ${fmt(current.restoreToMessage.medianChangeRatio, 2)}`,
		});

	const drift = current.snapshot?.mismatched ?? [];
	if (drift.length > 0)
		push({
			id: "snapshot-drift",
			severity: "warn",
			title: "落库账本快照与当前现场逐行不一致",
			detail:
				"报告里引用的 fit 分布必须是机读产物的复述；不一致时先重跑账本再引用。",
			evidence: drift
				.map((item) => `${item.id} ${item.snapshot}→${item.current}`)
				.join("；"),
		});

	const prose = current.reportProse;
	if (prose)
		push({
			id: "report-prose-drift",
			severity: "warn",
			title: "报告正文的 fit 分布与机读账本不一致",
			detail:
				"生成的表格与转述的正文是两条路径；转述没人核对，所以由监控核。以机读产物为准改正文。",
			evidence: `${prose.file} 声称 aligned ${prose.claimed[0]} · partial ${prose.claimed[1]} · unknown ${prose.claimed[2]}，实测 aligned ${current.histogram.aligned} · partial ${current.histogram.partial} · unknown ${current.histogram.unknown}`,
		});

	if (current.natural.pending > 0)
		push({
			id: "natural-pending",
			severity: "info",
			title: "L1 认可率在等自然使用（不可由脚本生成）",
			detail:
				"脚本与模型安排的手势只会把读数收敛到脚本常数，不构成用户认可；把待复核地标排成队列，人过了就是自然证据。",
			evidence: `当前 ${fmt(current.natural.endorsedShare)}（认可 ${current.natural.endorsed} / 全部 ${current.natural.total}），待复核 ${current.natural.pending}`,
		});

	if (current.days < 14)
		push({
			id: "calendar-window",
			severity: "info",
			title: "自然使用日历窗口未满 14 天（设计上不阻塞工程）",
			detail:
				"TF-0141 已把工程推进的门从日历改成样本量；日历只作长期观察记录，不得伪造经过的日期。",
			evidence: `事件跨度 ${current.days.toFixed(2)} 天`,
		});

	return alerts;
}
