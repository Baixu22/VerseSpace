/**
 * TF-0137 · fit 账本的指标表。
 *
 * 两条纪律决定了这张表长什么样：
 *
 * 1. **词表与森林统一。** fit 只取 task-forest `alignment.fit` 的五个值
 *    （aligned / partial / weak / misaligned / unknown）。节点原文里的
 *    known-positive / known-negative / harmful 一套不再使用——账本和森林
 *    各说一套词，砍留决策就没法引用。
 * 2. **无真实使用保持 unknown。** 每条非 unknown 结论必须引用 stats 输出或
 *    事件类型。测试通过不算使用，所以「有测试」永远不会把一行推离 unknown。
 *
 * 表里 authored 的是「哪个行为算这个部件有用」，measured 的是那个行为的当前值。
 * 前者是判断，后者是事实，两者在输出里分列，不混。
 */

import type { ChatStats } from "../../src/chat/stats";
import type { WorkbenchEvent } from "../../src/types/event";
import type { WriterKind } from "../../src/types/session";

/** 与 task-forest references/goal-alignment.md 的 fit 词表逐字一致。 */
export type Fit = "aligned" | "partial" | "weak" | "misaligned" | "unknown";

/**
 * 样本来源是运行者的声明（--evidence-kind），不筛选事件，只决定哪些结论
 * 允许被这批事件推动：L3 复评与人类认可类指标都只认 natural。
 */
export const EVIDENCE_KINDS = [
	"unknown",
	"scripted",
	"live-model",
	"natural",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Ctx {
	stats: ChatStats;
	events: WorkbenchEvent[];
	/** writer id → kind：premise_stale 的 payload 不带写者类型，只能回查注册表。 */
	writerKind: Map<string, WriterKind>;
}

export interface Probe {
	/**
	 * component  有运行时行为可测，fit 由实测值决定。
	 * record     决策 / 实验 / 缺陷修复：没有运行时行为，也就没有 stats 或事件
	 *            可引。按纪律 2 它的 fit 恒为 unknown，trace 只作为去哪里复核的
	 *            指路，不充当证据。
	 */
	kind: "component" | "record";
	metric: string;
	source: string;
	trace?: string;
	/**
	 * natural  该指标度量的是人的判断（如 L1「这是核心吗」）。脚本或模型运行
	 *          安排的手势不构成人的判断——它们只会把读数收敛到脚本里的常数——
	 *          所以只有 --evidence-kind natural 才准让实测值推动 fit；其余来源下
	 *          值照常显示，fit 停在 unknown（TF-0154 证据栏、TF-0136 执行提示）。
	 */
	requires?: "natural";
	/**
	 * 证据缺口 unknown 的处置结论（issue #13）。只在该探针的 fit 停在 unknown 时
	 * 才有意义，所以它不是阈值、不是判据——它回答的是「这行怎么样才算有结论」。
	 * 不填的组件行停在「证据缺口」分类，处置留空。
	 */
	disposition?: string;
	read?(ctx: Ctx): { value: number | null; samples: number };
	/** 有样本时的判据；不给就停在 partial（在用，但阈值还没定）。 */
	judge?(value: number): Fit;
}

const count = (ctx: Ctx, type: string): number =>
	ctx.events.filter((event) => event.type === type).length;

const plain = (value: number): { value: number; samples: number } => ({
	value,
	samples: value,
});

/** null 覆盖率就是「没有分母」，不是 0%。 */
const ratio = (
	value: number | null,
): { value: number | null; samples: number } =>
	value === null ? { value: null, samples: 0 } : { value, samples: 1 };

/** 护城河 B 的口径：推定写者是 git 或人的失效通知条数。 */
export function gitOrHumanNotices(ctx: Ctx): number {
	let hits = 0;
	for (const event of ctx.events) {
		if (event.type !== "premise_stale") continue;
		const writer = (event.payload as { writer?: unknown } | null)?.writer;
		if (typeof writer !== "string") continue;
		const kind = ctx.writerKind.get(writer);
		if (kind === "git" || kind === "human") hits += 1;
	}
	return hits;
}

export const PROBES: Record<string, Probe> = {
	"TF-0122": {
		kind: "component",
		metric: "基线可读：分叉 + 切换 + 恢复的合计次数",
		source: "stats.forks.total / stats.lifecycle.switches / .restores",
		read: (c) =>
			plain(
				c.stats.forks.total +
					c.stats.lifecycle.switches +
					c.stats.lifecycle.restores,
			),
	},
	"TF-0123": {
		kind: "component",
		metric: "带稳定身份（id + eventSeq）的事件条数",
		source: "events[].id / events[].eventSeq",
		read: (c) =>
			plain(
				c.events.filter((e) => e.id !== undefined && e.eventSeq !== undefined)
					.length,
			),
	},
	"TF-0124": {
		kind: "component",
		metric: "会话生命周期事件条数（这些必须不进世界投影）",
		source: "events[type^=thread.]",
		read: (c) =>
			plain(c.events.filter((e) => e.type.startsWith("thread.")).length),
	},
	"TF-0125": {
		kind: "component",
		metric: "落定过三种继承事实的分叉数",
		source: "events[thread.inheritance_observed]",
		read: (c) => plain(count(c, "thread.inheritance_observed")),
	},
	"TF-0127": {
		kind: "component",
		metric: "带读集 diff 的恢复次数",
		source: "stats.lifecycle.restores",
		read: (c) => plain(c.stats.lifecycle.restores),
	},
	"TF-0128": {
		kind: "component",
		metric: "恢复卡被真正消费的次数（笔记 + 恢复动作）",
		source: "stats.lifecycle.resumeNotesConsumed / .resumeActions",
		read: (c) =>
			plain(
				c.stats.lifecycle.resumeNotesConsumed + c.stats.lifecycle.resumeActions,
			),
	},
	"TF-0129": {
		kind: "component",
		metric: "足迹覆盖率（恢复卡事实段的分母）",
		source: "stats.threads.footprintCoverage",
		read: (c) => ratio(c.stats.threads.footprintCoverage),
		judge: (v) => (v >= 0.5 ? "aligned" : "partial"),
	},
	"TF-0131": {
		kind: "component",
		metric: "写出 inherited 读集的分叉数",
		source: "events[footprint.inherited]",
		read: (c) => plain(count(c, "footprint.inherited")),
	},
	"TF-0134": {
		kind: "component",
		metric: "封印决策次数（护城河 C 的分母）",
		source: "stats.seal.decisions",
		read: (c) => plain(c.stats.seal.decisions),
	},
	"TF-0133": {
		kind: "component",
		metric: "实际交付的通知束数（预算与折叠正确性另由契约测试验证）",
		source: "events[premise_notice_delivered]；不以 queued 充当 delivered",
		read: (c) => plain(count(c, "premise_notice_delivered")),
	},
	"TF-0139": {
		kind: "component",
		metric: "会话观测埋点合计（切换 + 恢复 + 笔记消费 + 恢复动作）",
		source: "stats.lifecycle.*",
		read: (c) =>
			plain(
				c.stats.lifecycle.switches +
					c.stats.lifecycle.restores +
					c.stats.lifecycle.resumeNotesConsumed +
					c.stats.lifecycle.resumeActions,
			),
	},
	"TF-0142": {
		kind: "component",
		metric: "被显式标成不可观测的通道数（HTTP 无工具通道）",
		source: "stats.noticeOutcomes.agent.unknownBy.unobservable",
		read: (c) => plain(c.stats.noticeOutcomes.agent.unknownBy.unobservable),
		// 当前值 0 是好消息（没有通知走过被显式排除的通道），但样本为 0 就
		// 无法证明降级语义真的被执行过。处置不是去 live 现场造样本——那会把
		// 通道语义测试记成使用数据——而是在 fixture 里造一条走不可观测通道
		// 的投递，验证计数路径活着（notice-outcome.test.ts 的 unobservable
		// 用例 + ledger.test.ts 的 unknownBy 分类用例）。
		disposition:
			"fixture 通道语义测试验证 unknownBy.unobservable 计数路径活着；不在 live 现场造样本",
	},
	"TF-0143": {
		kind: "component",
		metric: "有足迹的线程数（写路径预算的分母）",
		source: "stats.threads.withFootprints",
		read: (c) => plain(c.stats.threads.withFootprints),
	},
	"TF-0145": {
		kind: "component",
		metric: "进过世界投影的世界事件条数（截断行未单独计数，指标偏弱）",
		source: "events[!thread.*]",
		read: (c) =>
			plain(c.events.filter((e) => !e.type.startsWith("thread.")).length),
	},
	"TF-0148": {
		kind: "component",
		metric: "校准表行数（护城河 A）",
		source: "stats.noticeOutcomes.rows",
		read: (c) => plain(c.stats.noticeOutcomes.rows),
		judge: (v) => (v >= 50 ? "aligned" : "partial"),
	},
	"TF-0149": {
		kind: "component",
		metric: "notified / overlaps（护城河 D，目标区间 10-30%）",
		source: "stats.premises.notifiedRatio",
		read: (c) => ratio(c.stats.premises.notifiedRatio),
		judge: (v) => (v >= 0.1 && v <= 0.3 ? "aligned" : "partial"),
	},
	"TF-0150": {
		kind: "component",
		metric: "推定写者是 git 或人的失效通知条数（护城河 B）",
		source: "events[premise_stale] ⋈ sessions/<writer>.kind",
		read: (c) => plain(gitOrHumanNotices(c)),
	},
	"TF-0141": {
		kind: "component",
		metric: "t0 是否已登记：真实线程数（判据的一半，另一半是注册写者）",
		source: "stats.threads.total × sessions/*",
		read: (c) => plain(c.stats.threads.total),
	},
	"TF-0137": {
		kind: "record",
		metric: "账本是否被引用于一次真实砍留决策",
		source: "无运行时来源",
		trace: "docs/fit-ledger.md；判决归 TF-0136，账本只提供行与来源",
	},
	"TF-0138": {
		kind: "record",
		metric: "架构边界是否被后续评审引用",
		source: "无运行时来源",
		trace: "docs/decisions/0010-premise-custody.md（已接受）",
	},
	"TF-0140": {
		kind: "record",
		metric: "实验结论是否改变了下游决策",
		source: "无运行时来源",
		trace:
			"docs/report-2026-09-05-claude-fork-inheritance.md；已定形 TF-0131 并修订 ADR-0010 §5",
	},
	"TF-0144": {
		kind: "record",
		metric: "提交闸门是否真的挡住了『代码领先森林』",
		source: "无运行时来源",
		trace: "git log（TF-0144 之后的落库批次）",
	},
	"TF-0153": {
		kind: "record",
		metric: "影子黑板缺陷是否复发",
		source: "无运行时来源",
		trace: "提交 b292dc4",
	},
	"TF-0151": {
		kind: "component",
		metric: "R10 分支行是否被恢复卡消费（查看分支手势）",
		source:
			"events[thread.resume_action].payload.action = resume_branch_opened",
		read: (ctx) =>
			plain(
				ctx.events.filter(
					(event) =>
						event.type === "thread.resume_action" &&
						(event.payload as { action?: string } | null)?.action ===
							"resume_branch_opened",
				).length,
			),
	},
	"TF-0136": {
		kind: "record",
		metric: "四项判决是否改变了下游决策",
		source: "无运行时来源",
		trace:
			"docs/tf0136-verdict.md；scripts/fit-ledger/verdicts.ts（四项判据；L3 延后）",
	},
	"TF-0135": {
		kind: "record",
		metric: "范围仲裁结论是否写回并被执行",
		source: "无运行时来源",
		trace: "docs/tf0136-verdict.md；docs/fit-ledger.md（当前现场、读数与边界）",
	},
	"TF-0154": {
		kind: "component",
		metric:
			"L1 认可率（新口径 session-top-k）：已认可候选 / 全部当前候选，按写者隔离并取最新复核；≥0.8 为 aligned",
		source:
			"stats.landmarkReviews.current.endorsedShare（每会话文件级 top-K + 种类门；reviewedCoverage 与 legacyReviews 单列；旧口径 .threshold 并报一个周期）",
		requires: "natural",
		// 读数 0.333 只反映脚本或模型运行安排的复核手势，不构成用户认可。处置
		// 不是多跑几轮脚本把读数拉到 0.8——TF-0167 §F5 已否决受控实验路线，
		// 读数只会收敛到脚本里的认可概率。这行的 unknown 只能由 issue #12 的
		// J3 条件②（真实使用者参与复核）解开，本 issue 不单独追。
		disposition:
			"依赖 issue #12 的 J3 条件②（真实使用者参与复核）；不靠多跑脚本拉读数（TF-0167 §F5 已否决受控实验路线）",
		read: (ctx) => {
			const current = ctx.stats.landmarkReviews.current;
			return {
				value: current.endorsedShare,
				samples: current.reviewed,
			};
		},
		judge: (value) =>
			value >= 0.8 ? "aligned" : value >= 0.5 ? "partial" : "weak",
	},
	/**
	 * TF-0159 是**口径变更**本身，所以它的读数不是认可率而是「这把尺子量不量得出东西」：
	 * 有文件级触碰的会话里，多少能排出非空的 top-K。旧口径在四个现场全部归零——这条
	 * 读数是「为什么换尺子」的常驻证据，不切口径也不会消失。
	 */
	"TF-0159": {
		kind: "component",
		metric:
			"相对选择的可计量性：有文件级触碰的会话中 top-K 非空的比例（旧阈值口径在四现场为 0 → 判据不可计算）",
		source:
			"stats.landmarkReviews.coverage.share（withSet / sessions）；四现场实测门后 83/83、30/30、13/13、10/10",
		read: (ctx) => {
			const coverage = ctx.stats.landmarkReviews.coverage;
			return { value: coverage.share, samples: coverage.sessions };
		},
		judge: (value) =>
			value >= 0.8 ? "aligned" : value >= 0.5 ? "partial" : "weak",
	},
	"TF-0155": {
		kind: "record",
		metric: "真实模型执行、复读恢复与持久分叉验证是否可复跑",
		source: "独立验证现场的模型调用记录；不是通用产品行为指标",
		trace:
			"docs/report-2026-09-07-live-model.md；docs/live-model-evidence-2026-09-07.json",
	},
	"TF-0160": {
		kind: "component",
		metric:
			"代理自审认可率（steward）：无真人时由 agent 按证据复核地标，≥0.8 表示「投影选出来的核心」与证据一致",
		source:
			"stats.landmarkReviews.steward.endorsedShare；与 TF-0154 的 human 口径**分开报**，不构成用户认可",
		read: (ctx) => {
			const steward = ctx.stats.landmarkReviews.steward;
			return { value: steward.endorsedShare, samples: steward.reviewed };
		},
		judge: (value) =>
			value >= 0.8 ? "aligned" : value >= 0.5 ? "partial" : "weak",
	},
};
