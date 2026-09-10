/**
 * TF-0135 / TF-0136 / TF-0137 · 监控规则的回归。
 *
 * 钉的是规则不是数字：门槛掉了要报 high，长期项要停在 info，报告和账本对不上
 * 要能自己冒出来。数字本身由每次采样决定，写死在测试里只会变成噪声。
 */

import { describe, expect, it } from "bun:test";
import { evaluateAlerts } from "./alerts";
import type { Alert, MonitorSample } from "./types";

function sample(overrides: Partial<MonitorSample> = {}): MonitorSample {
	const base: MonitorSample = {
		at: "2026-09-10T00:00:00.000Z",
		kind: "fit-monitor-sample",
		evidenceKind: "live-model",
		workspace: "C:/tenant",
		blackboard: "C:/tenant/.workbench",
		threads: 69,
		writers: 75,
		events: 1600,
		days: 2,
		t0Started: true,
		sampleWindow: {
			restores: 38,
			noticeOutcomes: 95,
			sealDecisions: 20,
			targets: { restores: 3, noticeOutcomes: 5, sealDecisions: 3 },
			satisfied: true,
			missing: [],
		},
		moat: [
			{
				key: "A",
				name: "校准表行数",
				threshold: "≥ 50",
				source: "s",
				value: 95,
				present: true,
			},
			{
				key: "B",
				name: "git/human",
				threshold: "≥ 1",
				source: "s",
				value: 1,
				present: true,
			},
			{
				key: "C",
				name: "seal block",
				threshold: "≥ 1",
				source: "s",
				value: 18,
				present: true,
			},
			{
				key: "D",
				name: "notified/overlaps",
				threshold: "10-30%",
				source: "s",
				value: 0.149,
				present: true,
			},
		],
		gate: { open: true, missing: [] },
		verdicts: [
			{ id: "resume-card", title: "判决一：恢复卡", status: "supported" },
			{
				id: "premise-detection",
				title: "判决二：前提检测",
				status: "supported",
			},
			{ id: "stage-c", title: "判决三：阶段 C", status: "supported" },
			{ id: "l3", title: "判决四：L3", status: "insufficient-evidence" },
		],
		histogram: { aligned: 3, partial: 15, weak: 0, misaligned: 0, unknown: 9 },
		unknown: {
			total: 9,
			record: 7,
			unbuilt: 0,
			noSample: 1,
			natural: 1,
			ids: [],
		},
		natural: {
			total: 84,
			reviewed: 11,
			endorsed: 10,
			rejected: 1,
			endorsedShare: 0.119,
			reviewedCoverage: 0.13,
			pending: 73,
		},
		restoreToMessage: {
			samples: 19,
			medianChangeRatio: 317,
			exceeds20Percent: true,
		},
		dataQuality: { insufficientHistory: false, reasons: [] },
		rounds: {
			total: 18,
			ok: 18,
			failed: 0,
			lastAt: "2026-09-10T14:56:49.829Z",
		},
		model: {
			calls: 660,
			attempts: 668,
			retryRate: 0.012,
			outcomes: { response: 660 },
			lastOutcomeAt: null,
		},
		snapshot: null,
		reportProse: null,
	};
	return { ...base, ...overrides };
}

const ids = (alerts: Alert[]): string[] => alerts.map((alert) => alert.id);
const severityOf = (alerts: Alert[], id: string): string | undefined =>
	alerts.find((alert) => alert.id === id)?.severity;

const withAlerts = (overrides: Partial<MonitorSample> = {}): Alert[] =>
	evaluateAlerts(sample(), sample(overrides));

describe("fit 监控告警规则", () => {
	it("门槛齐备但没有新累积时：没有 high，只有长期项与停滞提醒", () => {
		const alerts = evaluateAlerts(sample(), sample());
		expect(alerts.filter((alert) => alert.severity === "high")).toEqual([]);
		expect(ids(alerts).sort()).toEqual([
			"calendar-window",
			"natural-pending",
			"restore-latency",
			"sampling-stalled",
		]);
		expect(severityOf(alerts, "calendar-window")).toBe("info");
		expect(severityOf(alerts, "natural-pending")).toBe("info");
	});

	it("L1 待复核是 info 而不是故障：脚本不能替人回答", () => {
		const alerts = withAlerts();
		expect(severityOf(alerts, "natural-pending")).toBe("info");
		expect(severityOf(alerts, "calendar-window")).toBe("info");
	});

	it("闸门关闭是 high，并报出缺哪个数字", () => {
		const alerts = withAlerts({
			gate: { open: false, missing: ["B git/human"] },
		});
		expect(severityOf(alerts, "gate-closed")).toBe("high");
		expect(
			alerts.find((alert) => alert.id === "gate-closed")?.evidence,
		).toContain("B git/human");
	});

	it("样本窗口未凑齐是 high", () => {
		const alerts = withAlerts({
			sampleWindow: {
				restores: 1,
				noticeOutcomes: 95,
				sealDecisions: 20,
				targets: { restores: 3, noticeOutcomes: 5, sealDecisions: 3 },
				satisfied: false,
				missing: ["restores 1/3"],
			},
		});
		expect(severityOf(alerts, "window-unsatisfied")).toBe("high");
	});

	it("样本计数倒退是 high：累积样本只应单调增", () => {
		const alerts = withAlerts({
			sampleWindow: {
				restores: 20,
				noticeOutcomes: 95,
				sealDecisions: 20,
				targets: { restores: 3, noticeOutcomes: 5, sealDecisions: 3 },
				satisfied: true,
				missing: [],
			},
		});
		expect(severityOf(alerts, "window-regression")).toBe("high");
		expect(
			alerts.find((alert) => alert.id === "window-regression")?.evidence,
		).toContain("恢复周期 38→20");
	});

	it("已 supported 的判决掉出门槛是 high", () => {
		const alerts = withAlerts({
			verdicts: [
				{ id: "resume-card", title: "判决一：恢复卡", status: "not-supported" },
				{
					id: "premise-detection",
					title: "判决二：前提检测",
					status: "supported",
				},
				{ id: "stage-c", title: "判决三：阶段 C", status: "supported" },
				{ id: "l3", title: "判决四：L3", status: "insufficient-evidence" },
			],
		});
		expect(severityOf(alerts, "verdict-regression")).toBe("high");
	});

	it("护城河从齐备掉成缺项是 high", () => {
		const alerts = withAlerts({
			moat: [
				{
					key: "A",
					name: "校准表行数",
					threshold: "≥ 50",
					source: "s",
					value: 95,
					present: true,
				},
				{
					key: "B",
					name: "git/human",
					threshold: "≥ 1",
					source: "s",
					value: 0,
					present: false,
				},
				{
					key: "C",
					name: "seal block",
					threshold: "≥ 1",
					source: "s",
					value: 18,
					present: true,
				},
				{
					key: "D",
					name: "notified/overlaps",
					threshold: "10-30%",
					source: "s",
					value: 0.149,
					present: true,
				},
			],
		});
		expect(severityOf(alerts, "moat-regression")).toBe("high");
	});

	it("跑次失败增加是 high", () => {
		const alerts = withAlerts({
			rounds: { total: 19, ok: 18, failed: 1, lastAt: null },
		});
		expect(severityOf(alerts, "round-failures")).toBe("high");
	});

	it("t0 未开始是 high；从已开始退回也是 high", () => {
		expect(
			severityOf(
				evaluateAlerts(null, sample({ t0Started: false })),
				"t0-not-started",
			),
		).toBe("high");
		expect(severityOf(withAlerts({ t0Started: false }), "t0-lost")).toBe(
			"high",
		);
	});

	it("两次采样之间没有累积是 warn（监控在空转）", () => {
		const alerts = evaluateAlerts(sample(), sample({ model: sample().model }));
		expect(severityOf(alerts, "sampling-stalled")).toBe("warn");
	});

	it("重试率超过 5% 是 warn，可恢复错误本身只记 info", () => {
		const alerts = withAlerts({
			model: {
				calls: 660,
				attempts: 700,
				retryRate: 0.06,
				outcomes: { response: 660, "http-error": 3 },
				lastOutcomeAt: null,
			},
		});
		expect(severityOf(alerts, "retry-rate")).toBe("warn");
		expect(severityOf(alerts, "model-error-outcomes")).toBe("info");
	});

	it("快照行级漂移与报告正文漂移都是 warn", () => {
		const drifted = withAlerts({
			snapshot: {
				file: "docs/fit-ledger-x.md",
				rowsCompared: 27,
				mismatched: [
					{ id: "TF-0129", snapshot: "partial", current: "aligned" },
				],
			},
			reportProse: { file: "docs/report-x.md", claimed: [3, 16, 6] },
		});
		expect(severityOf(drifted, "snapshot-drift")).toBe("warn");
		expect(severityOf(drifted, "report-prose-drift")).toBe("warn");
	});

	it("unknown 上升要能拆开成口径还是退步", () => {
		const alerts = withAlerts({
			histogram: {
				aligned: 3,
				partial: 14,
				weak: 0,
				misaligned: 0,
				unknown: 10,
			},
			unknown: {
				total: 10,
				record: 7,
				unbuilt: 0,
				noSample: 2,
				natural: 1,
				ids: [],
			},
		});
		const drift = alerts.find((alert) => alert.id === "unknown-drift");
		expect(drift?.severity).toBe("warn");
		expect(drift?.evidence).toContain("无样本部件 1→2");
	});
});
