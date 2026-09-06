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
		trace: "docs/decisions/0010-premise-custody.md（提案，待评审）",
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
};
