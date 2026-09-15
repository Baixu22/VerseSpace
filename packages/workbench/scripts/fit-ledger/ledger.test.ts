/**
 * TF-0137 · 账本推导规则的单测。
 *
 * 这里钉的不是数字，是**规则**：t0 之前不准出现非 unknown、record 类不准借
 * trace 升级、护城河闸门缺一不开、deprecated 不进分母。数字随真实使用变，
 * 规则不能变——它们是「账本不许自己造结论」这条纪律的可执行形式。
 */

import { describe, expect, test } from "bun:test";
import type { ChatStats } from "../../src/chat/stats";
import type { WorkbenchEvent } from "../../src/types/event";
import {
	benchmarkGate,
	buildRows,
	fitHistogram,
	moatNumbers,
	sampleWindow,
	t0Started,
} from "./ledger";
import type { Ctx } from "./metrics";

/** 只填账本读到的字段；其余用 0/null，避免让测试依赖 stats 的全貌。 */
function stats(over: Record<string, unknown> = {}): ChatStats {
	const base = {
		threads: {
			total: 0,
			withMessages: 0,
			withFootprints: 0,
			withResumeNotes: 0,
			forked: 0,
			resumeNoteCoverage: null,
			footprintCoverage: null,
		},
		forks: {
			total: 0,
			perWeek: null,
			depth: { min: 0, max: 0, average: 0 },
			families: { count: 0, largestSize: 0 },
		},
		observation: { startedAt: null, endedAt: null, days: 0 },
		lifecycle: {
			switches: 0,
			restores: 0,
			resumeNotesConsumed: 0,
			resumeActions: 0,
			restoreFirstAction: { observed: 0, known: 0, unknown: 0, byKind: {} },
		},
		siblingAlternation: {
			available: false,
			reason: "",
			families: 0,
			alternatingFamilies: 0,
			rate: null,
			transitions: 0,
			windowMinutes: 30,
		},
		premises: { passes: 0, notifiedRatio: null },
		premisesRecent: {
			windowDays: 7,
			passes: 0,
			overlaps: 0,
			notified: 0,
			ratio: null,
		},
		seal: {
			decisions: 0,
			blocked: 0,
			reviews: { total: 0, correct: 0, incorrect: 0 },
		},
		noticeOutcomes: { rows: 0, agent: { unknownBy: { unobservable: 0 } } },
		landmarkReviews: { endorsed: 0, rejected: 0, lastAt: null },
		dataQuality: { insufficientHistory: true, reasons: [] },
	};
	return { ...base, ...over } as unknown as ChatStats;
}

function ctx(over: Partial<Ctx> = {}): Ctx {
	return {
		stats: stats(),
		events: [] as WorkbenchEvent[],
		writerKind: new Map(),
		...over,
	};
}

const NODES = [
	{ id: "TF-0120", title: "里程碑", status: "in_progress", kind: "milestone" },
	{ id: "TF-0148", title: "校准表", status: "done", kind: "task" },
	{ id: "TF-0140", title: "实验", status: "done", kind: "task" },
	{ id: "TF-0133", title: "未开工", status: "proposed", kind: "task" },
];
const L1_NODE = [
	{ id: "TF-0154", title: "地标认可", status: "done", kind: "task" },
];
/** TF-0142 在 NODES 里没有，它的处置结论测试单独给它一个 scope。 */
const B_CLASS_NODES = [
	{ id: "TF-0142", title: "通知通道语义与测试", status: "done", kind: "task" },
];

describe("fit 账本推导规则（TF-0137）", () => {
	test("t0 判据：既要有真实线程，也要有注册写者，缺一不算开始", () => {
		expect(t0Started(ctx())).toBe(false);
		expect(t0Started(ctx({ stats: stats({ threads: { total: 3 } }) }))).toBe(
			false,
		);
		expect(t0Started(ctx({ writerKind: new Map([["w", "agent"]]) }))).toBe(
			false,
		);
		expect(
			t0Started(
				ctx({
					stats: stats({ threads: { total: 3 } }),
					writerKind: new Map([["w", "agent"]]),
				}),
			),
		).toBe(true);
	});

	test("t0 之前：即使指标读到值，fit 也必须停在 unknown，值照常显示", () => {
		// 校准表读到 60 行——阈值 50 本会判 aligned，但 t0 未开始
		const before = buildRows(
			NODES,
			ctx({ stats: stats({ noticeOutcomes: { rows: 60 } }) }),
		);
		const row = before.find((r) => r.id === "TF-0148")!;
		expect(row.value).toBe(60);
		expect(row.fit).toBe("unknown");
		expect(row.why).toContain("t0 未开始");
		expect(fitHistogram(before).aligned).toBe(0);

		// 同样的 60 行，t0 开始之后才准升级
		const after = buildRows(
			NODES,
			ctx({
				stats: stats({ noticeOutcomes: { rows: 60 }, threads: { total: 1 } }),
				writerKind: new Map([["w", "agent"]]),
			}),
		);
		expect(after.find((r) => r.id === "TF-0148")!.fit).toBe("aligned");
	});

	test("阈值未达：有样本但不够门槛是 partial，不是 aligned，也不是 unknown", () => {
		const rows = buildRows(
			NODES,
			ctx({
				stats: stats({ noticeOutcomes: { rows: 3 }, threads: { total: 1 } }),
				writerKind: new Map([["w", "agent"]]),
			}),
		);
		expect(rows.find((r) => r.id === "TF-0148")!.fit).toBe("partial");
	});

	test("人类认可类指标只认 natural 来源：脚本手势下值照常显示，fit 停在 unknown", () => {
		// 47 个地标里 46 个被复核、35 个 endorse——正好是 landmark-coverage.ts 的
		// 0.75 抛硬币常数。t0 已开始、样本充足，只差来源不是自然使用。
		const started = ctx({
			stats: stats({
				threads: { total: 53 },
				landmarkReviews: {
					endorsed: 35,
					rejected: 11,
					lastAt: "t",
					current: {
						total: 47,
						reviewed: 46,
						endorsed: 35,
						rejected: 11,
						endorsedShare: 35 / 47,
						reviewedCoverage: 46 / 47,
						byWriter: [],
					},
				},
			}),
			writerKind: new Map([["w", "agent"]]),
		});
		for (const kind of ["unknown", "scripted", "live-model"] as const) {
			const row = buildRows(L1_NODE, started, kind)[0]!;
			expect(row.value).toBe(35 / 47);
			expect(row.samples).toBe(46);
			expect(row.fit).toBe("unknown");
			expect(row.why).toContain("不构成用户认可");
		}
		// 同一批数字若真来自自然使用，才按 0.5 / 0.8 门槛判 partial / aligned。
		expect(buildRows(L1_NODE, started, "natural")[0]!.fit).toBe("partial");
		// 不带来源参数的调用视同 unknown，不会默认放行。
		expect(buildRows(L1_NODE, started)[0]!.fit).toBe("unknown");
		// 门只作用于 requires: natural 的指标：校准表行数照常按阈值判。
		const calibration = buildRows(
			NODES,
			ctx({
				stats: stats({ noticeOutcomes: { rows: 60 }, threads: { total: 1 } }),
				writerKind: new Map([["w", "agent"]]),
			}),
			"live-model",
		).find((r) => r.id === "TF-0148")!;
		expect(calibration.fit).toBe("aligned");
	});

	test("record 类（决策/实验/修复）永远 unknown：trace 是指路，不是证据", () => {
		const rows = buildRows(
			NODES,
			ctx({
				stats: stats({ threads: { total: 9 } }),
				writerKind: new Map([["w", "human"]]),
			}),
		);
		const record = rows.find((r) => r.id === "TF-0140")!;
		expect(record.kind).toBe("record");
		expect(record.fit).toBe("unknown");
		expect(record.trace).toContain("report-2026-09-05-claude-fork-inheritance");
		// t0 已开始也不升级：它没有 stats 或事件来源可引
		expect(record.why).toContain("无 stats 或事件可引");
	});

	test("unknown 分两类（issue #13）：record 是结构性，组件缺样本是证据缺口", () => {
		const started = ctx({
			stats: stats({ threads: { total: 9 } }),
			writerKind: new Map([["w", "human"]]),
		});
		// record 行无论 t0 是否开始，都是结构性 unknown——纪律规定如此，不是缺口
		expect(
			buildRows(NODES, started).find((r) => r.id === "TF-0140")!.unknownClass,
		).toBe("structural");

		// 组件行有指标但 t0 未开始：证据缺口
		const before = buildRows(NODES, ctx()).find((r) => r.id === "TF-0148");
		expect(before!.fit).toBe("unknown");
		expect(before!.unknownClass).toBe("evidence-gap");

		// 有处置结论的探针（TF-0142）只在停在 unknown 时携带处置
		const gap = buildRows(B_CLASS_NODES, ctx()).find((r) => r.id === "TF-0142");
		expect(gap!.unknownClass).toBe("evidence-gap");
		expect(gap!.disposition).toContain("unknownBy.unobservable");

		// 组件行一旦离开 unknown，分类与处置都消失，不残留
		const resolved = buildRows(
			NODES,
			ctx({
				stats: stats({ noticeOutcomes: { rows: 60 }, threads: { total: 1 } }),
				writerKind: new Map([["w", "agent"]]),
			}),
		).find((r) => r.id === "TF-0148")!;
		expect(resolved.fit).toBe("aligned");
		expect(resolved.unknownClass).toBeUndefined();
		expect(resolved.disposition).toBeUndefined();
	});

	test("里程碑不计入 fit 分布，避免把子节点的 unknown 重复计一次", () => {
		const rows = buildRows(NODES, ctx());
		expect(rows.find((r) => r.id === "TF-0120")!.kind).toBe("milestone");
		// 4 个节点里 1 个是里程碑 → 只统计 3 个
		const h = fitHistogram(rows);
		expect(h.unknown + h.partial + h.aligned + h.weak + h.misaligned).toBe(3);
	});

	test("没进指标表的节点分两种说法：done 是账本缺口，未开工是没有可测行为", () => {
		const rows = buildRows(
			[
				{ id: "TF-0998", title: "未开工", status: "proposed", kind: "task" },
				{ id: "TF-0999", title: "已完成但漏了", status: "done", kind: "task" },
			],
			ctx(),
		);
		expect(rows[0]!.why).toContain("尚未开工");
		expect(rows[1]!.why).toContain("账本自己的缺口");
	});

	test("护城河闸门：四个数字缺一不开，且缺的那几个要报出名字", () => {
		const closed = moatNumbers(ctx());
		expect(closed.map((m) => m.present)).toEqual([false, false, false, false]);
		expect(benchmarkGate(closed).open).toBe(false);
		expect(benchmarkGate(closed).missing).toHaveLength(4);

		const full = moatNumbers(
			ctx({
				stats: stats({
					noticeOutcomes: { rows: 50 },
					seal: {
						decisions: 4,
						blocked: 1,
						reviews: { total: 1, correct: 1, incorrect: 0 },
					},
					premises: { passes: 10, notifiedRatio: 0.2 },
				}),
				events: [
					{
						timestamp: "t",
						source: "runtime",
						type: "premise_stale",
						payload: { writer: "git-writer" },
					},
				] as WorkbenchEvent[],
				writerKind: new Map([["git-writer", "git"]]),
			}),
		);
		expect(full.map((m) => m.present)).toEqual([true, true, true, true]);
		expect(benchmarkGate(full).open).toBe(true);
	});

	test("护城河 C 的「正确」腿：block 未复核或复核为误伤都不开闸", () => {
		const blockedOnly = moatNumbers(
			ctx({
				stats: stats({
					seal: {
						decisions: 4,
						blocked: 1,
						reviews: { total: 0, correct: 0, incorrect: 0 },
					},
				}),
			}),
		);
		expect(blockedOnly.find((m) => m.key === "C")!.present).toBe(false);

		const wrongReview = moatNumbers(
			ctx({
				stats: stats({
					seal: {
						decisions: 4,
						blocked: 1,
						reviews: { total: 1, correct: 0, incorrect: 1 },
					},
				}),
			}),
		);
		expect(wrongReview.find((m) => m.key === "C")!.present).toBe(false);
	});

	test("护城河 B 只认 git 或人：agent 自己的失效通知不算样本", () => {
		const agentOnly = moatNumbers(
			ctx({
				events: [
					{
						timestamp: "t",
						source: "runtime",
						type: "premise_stale",
						payload: { writer: "agent-1" },
					},
				] as WorkbenchEvent[],
				writerKind: new Map([["agent-1", "agent"]]),
			}),
		);
		expect(agentOnly.find((m) => m.key === "B")!.value).toBe(0);
		expect(agentOnly.find((m) => m.key === "B")!.present).toBe(false);
	});

	test("护城河 D 是区间不是下限：越界有值也不算齐备", () => {
		const tooHigh = moatNumbers(
			ctx({ stats: stats({ premises: { passes: 10, notifiedRatio: 0.9 } }) }),
		);
		expect(tooHigh.find((m) => m.key === "D")!.value).toBe(0.9);
		expect(tooHigh.find((m) => m.key === "D")!.present).toBe(false);
	});

	test("样本窗口（TF-0141 重设计）：三类样本齐了才算窗口凑齐，缺的报名字", () => {
		// 空黑板：三类全缺
		const empty = sampleWindow(ctx());
		expect(empty.satisfied).toBe(false);
		expect(empty.missing).toHaveLength(3);

		// 只补两类：仍差一个，且缺的名字可读
		const partial = sampleWindow(
			ctx({
				stats: stats({
					lifecycle: {
						switches: 0,
						restores: 3,
						resumeNotesConsumed: 0,
						resumeActions: 0,
						restoreFirstAction: {
							observed: 0,
							known: 0,
							unknown: 0,
							byKind: {},
						},
					},
					noticeOutcomes: {
						rows: 5,
						agent: { unknownBy: { unobservable: 0 } },
					},
					seal: {
						decisions: 1,
						blocked: 0,
						reviews: { total: 0, correct: 0, incorrect: 0 },
					},
				}),
			}),
		);
		expect(partial.satisfied).toBe(false);
		expect(partial.missing).toEqual(["sealDecisions 1/3"]);

		// 三类全达标：窗口凑齐——不管事件跨度是三天还是三十天
		const full = sampleWindow(
			ctx({
				stats: stats({
					lifecycle: {
						switches: 2,
						restores: 4,
						resumeNotesConsumed: 1,
						resumeActions: 1,
						restoreFirstAction: {
							observed: 2,
							known: 2,
							unknown: 0,
							byKind: {},
						},
					},
					noticeOutcomes: {
						rows: 7,
						agent: { unknownBy: { unobservable: 0 } },
					},
					seal: {
						decisions: 3,
						blocked: 1,
						reviews: { total: 1, correct: 1, incorrect: 0 },
					},
				}),
			}),
		);
		expect(full.satisfied).toBe(true);
		expect(full.missing).toEqual([]);
	});
});
