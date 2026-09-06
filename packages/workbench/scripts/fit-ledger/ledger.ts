/**
 * TF-0137 · 从森林 + 真实事件推出 fit 账本的行与护城河闸门。
 *
 * 所有判定都在这里，且只有两个输入：森林节点（scope 与状态）与本仓库
 * `.workbench/` 的真实事件（值）。测试通过不是输入。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ctx, Fit, Probe } from "./metrics";
import { gitOrHumanNotices, PROBES } from "./metrics";

export interface Row {
	id: string;
	title: string;
	status: string;
	kind: Probe["kind"] | "milestone" | "unbuilt";
	metric: string;
	source: string;
	trace?: string;
	value: number | null;
	samples: number;
	fit: Fit;
	why: string;
}

const MILESTONE_KINDS = new Set(["milestone", "global_task"]);

interface ForestNode {
	title: string;
	status: string;
	kind: string;
}

/** 森林是权威 scope：TF-0120 及其全部后代，deprecated 不入账（也不进分母）。 */
export async function loadScope(
	workspace: string,
	root = "TF-0120",
): Promise<Array<{ id: string } & ForestNode>> {
	const dir = join(workspace, ".agent-workbench", "task-forest", "graph");
	const nodes = JSON.parse(
		await readFile(join(dir, "nodes.json"), "utf8"),
	) as Record<string, ForestNode>;
	const edges = JSON.parse(await readFile(join(dir, "edges.json"), "utf8")) as
		| Array<{ from: string; to: string; type: string }>
		| Record<string, { from: string; to: string; type: string }>;
	const list = Array.isArray(edges) ? edges : Object.values(edges);
	const children = new Map<string, string[]>();
	for (const edge of list) {
		if (edge.type !== "child_of") continue;
		const bucket = children.get(edge.to);
		if (bucket) bucket.push(edge.from);
		else children.set(edge.to, [edge.from]);
	}
	const ids: string[] = [];
	const walk = (parent: string): void => {
		for (const child of (children.get(parent) ?? []).sort()) {
			ids.push(child);
			walk(child);
		}
	};
	walk(root);
	return [root, ...ids]
		.filter((id) => nodes[id] && nodes[id]!.status !== "deprecated")
		.map((id) => ({ id, ...nodes[id]! }));
}

/**
 * t0 是否已经开始（判据取自 TF-0141）：`.workbench/` 出现真实线程，且至少注册过
 * 一个写者。t0 之前 `events.jsonl` 里躺着的是自举期事件——把它们当样本，
 * 就会得出「事件身份 partial」这种由自测数据支撑的结论，正是纪律 2 要拦的东西。
 */
export function t0Started(ctx: Ctx): boolean {
	return ctx.stats.threads.total > 0 && ctx.writerKind.size > 0;
}

export function buildRows(
	scope: Array<{ id: string } & ForestNode>,
	ctx: Ctx,
): Row[] {
	const started = t0Started(ctx);
	return scope.map((node) => {
		const base = {
			id: node.id,
			title: node.title,
			status: node.status,
			value: null as number | null,
			samples: 0,
			fit: "unknown" as Fit,
		};
		if (MILESTONE_KINDS.has(node.kind)) {
			return {
				...base,
				kind: "milestone" as const,
				metric: "里程碑本身不是部件，fit 由其子节点上卷",
				source: "—",
				why: "里程碑不单独计 fit，避免把子节点的 unknown 重复计一次",
			};
		}
		const probe = PROBES[node.id];
		if (!probe) {
			return {
				...base,
				kind: "unbuilt" as const,
				metric: "尚未指定可观测指标",
				source: "—",
				why:
					node.status === "done"
						? "已完成但没进指标表：这是账本自己的缺口，补指标而不是补结论"
						: `状态 ${node.status}，尚未开工，没有可测行为`,
			};
		}
		if (probe.kind === "record") {
			return {
				...base,
				kind: "record" as const,
				metric: probe.metric,
				source: probe.source,
				trace: probe.trace,
				why: "决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown",
			};
		}
		const reading = probe.read?.(ctx) ?? { value: null, samples: 0 };
		// t0 之前一律 unknown，但 measured 值照常显示——看得见 15 条自举事件，
		// 又不让它推动 fit，这正是 authored / measured 分列的用处。
		const usable = started && reading.samples > 0;
		const fit: Fit = !usable
			? "unknown"
			: (probe.judge?.(reading.value ?? 0) ?? "partial");
		return {
			...base,
			kind: "component" as const,
			metric: probe.metric,
			source: probe.source,
			value: reading.value,
			samples: reading.samples,
			fit,
			why: !started
				? "t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本"
				: reading.samples === 0
					? `insufficient-history：${probe.source} 无样本`
					: `实测 ${reading.value}，来源 ${probe.source}`,
		};
	});
}

export interface MoatNumber {
	key: "A" | "B" | "C" | "D";
	name: string;
	threshold: string;
	source: string;
	value: number | string | null;
	present: boolean;
}

/**
 * 第 30 天回看的四个数字（TF-0137 验收六）。`present` 只问「存在且非零」，
 * 不问「够不够好」——后者是 TF-0136 的判决，不是账本的。
 */
export function moatNumbers(ctx: Ctx): MoatNumber[] {
	const { stats } = ctx;
	const ratio = stats.premises.notifiedRatio;
	const gitOrHuman = gitOrHumanNotices(ctx);
	return [
		{
			key: "A",
			name: "校准表行数",
			threshold: "≥ 50",
			source: "stats.noticeOutcomes.rows",
			value: stats.noticeOutcomes.rows,
			present: stats.noticeOutcomes.rows >= 50,
		},
		{
			key: "B",
			name: "推定写者是 git 或人的失效通知",
			threshold: "≥ 1 条",
			source: "events[premise_stale] ⋈ sessions/<writer>.kind",
			value: gitOrHuman,
			present: gitOrHuman >= 1,
		},
		{
			key: "C",
			name: "来自真实会话的 seal.decided: block",
			threshold: "≥ 1 次（且事后判定为正确封印）",
			source: "stats.seal.blocked",
			value: stats.seal.blocked,
			present: stats.seal.blocked >= 1,
		},
		{
			key: "D",
			name: "notified / overlaps",
			threshold: "有真实值且落在 10-30%",
			source: "stats.premises.notifiedRatio",
			value: ratio,
			present: ratio !== null && ratio >= 0.1 && ratio <= 0.3,
		},
	];
}

/** 四个数字齐备才准写对外的 stale-premise benchmark；缺一个先补它，不扩树。 */
export function benchmarkGate(moat: MoatNumber[]): {
	open: boolean;
	missing: string[];
} {
	const missing = moat
		.filter((m) => !m.present)
		.map((m) => `${m.key} ${m.name}`);
	return { open: missing.length === 0, missing };
}

export function fitHistogram(rows: Row[]): Record<Fit, number> {
	const out: Record<Fit, number> = {
		aligned: 0,
		partial: 0,
		weak: 0,
		misaligned: 0,
		unknown: 0,
	};
	for (const row of rows) {
		if (row.kind === "milestone") continue;
		out[row.fit] += 1;
	}
	return out;
}
