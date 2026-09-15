/**
 * TF-0137 · 从森林 + 真实事件推出 fit 账本的行与护城河闸门。
 *
 * 所有判定都在这里，且只有两个输入：森林节点（scope 与状态）与本仓库
 * `.workbench/` 的真实事件（值）。测试通过不是输入。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ctx, EvidenceKind, Fit, Probe } from "./metrics";
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
	/**
	 * unknown 的分类（issue #13）：同样是 `unknown`，一种是**结构性**的——
	 * 决策/实验/修复类节点按纪律 2 停在这里，有书面复核指针，用记录回答而不是
	 * 用数据回答；另一种是**证据缺口**的——部件有可观测指标，只是样本还没攒够
	 * 或来源不是自然使用。两者在对外叙事里必须分开，否则 7 行结构性 unknown
	 * 会被误读成「7 个部件没人用」。
	 */
	unknownClass?: "structural" | "evidence-gap";
	/** 证据缺口 unknown 的处置结论（来自探针的 `disposition`，见 metrics.ts）。 */
	disposition?: string;
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
	let nodes: Record<string, ForestNode>;
	let edges: Array<{ from: string; to: string; type: string }>;
	try {
		nodes = JSON.parse(
			await readFile(join(dir, "nodes.json"), "utf8"),
		) as Record<string, ForestNode>;
		const raw = JSON.parse(await readFile(join(dir, "edges.json"), "utf8")) as
			| Array<{ from: string; to: string; type: string }>
			| Record<string, { from: string; to: string; type: string }>;
		edges = Array.isArray(raw) ? raw : Object.values(raw);
	} catch {
		// 黑板不一定长在森林仓库里（如 E2E 租户）：没有森林就以黑板本身为
		// scope，行数为零但 t0 / 样本窗口 / 护城河照常推导。
		return [];
	}
	const list = edges;
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

/**
 * 样本窗口（TF-0141，2026-09-06 重设计）：裁决要不要继续看，看的是样本量，
 * 不是日历。旧的「t0+14d」日历门在工程探索阶段两头都失败——三天高强度使用
 * 可以攒齐两周才有的事件，两周挂机也可能一个恢复周期都没有。窗口凑齐 =
 * 三类核心行为样本各到既定数量；凑不齐，结论一律 insufficient-history。
 *
 * 目标值是工程探索的默认档，不是产品承诺：
 *   - restores ≥ 3：「离开→回来」循环至少三次，恢复卡的重复出现率才有意义；
 *   - noticeOutcomes ≥ 5：校准表不能靠单例下结论；
 *   - sealDecisions ≥ 3：block/warn/pass 都该出现过，降级路径也被踩过。
 */
export const SAMPLE_WINDOW_TARGETS = {
	restores: 3,
	noticeOutcomes: 5,
	sealDecisions: 3,
} as const;

export interface SampleWindow {
	restores: number;
	noticeOutcomes: number;
	sealDecisions: number;
	targets: typeof SAMPLE_WINDOW_TARGETS;
	satisfied: boolean;
	missing: string[];
}

export function sampleWindow(ctx: Ctx): SampleWindow {
	const restores = ctx.stats.lifecycle.restores;
	const noticeOutcomes = ctx.stats.noticeOutcomes.rows;
	const sealDecisions = ctx.stats.seal.decisions;
	const missing: string[] = [];
	if (restores < SAMPLE_WINDOW_TARGETS.restores) {
		missing.push(`restores ${restores}/${SAMPLE_WINDOW_TARGETS.restores}`);
	}
	if (noticeOutcomes < SAMPLE_WINDOW_TARGETS.noticeOutcomes) {
		missing.push(
			`noticeOutcomes ${noticeOutcomes}/${SAMPLE_WINDOW_TARGETS.noticeOutcomes}`,
		);
	}
	if (sealDecisions < SAMPLE_WINDOW_TARGETS.sealDecisions) {
		missing.push(
			`sealDecisions ${sealDecisions}/${SAMPLE_WINDOW_TARGETS.sealDecisions}`,
		);
	}
	return {
		restores,
		noticeOutcomes,
		sealDecisions,
		targets: SAMPLE_WINDOW_TARGETS,
		satisfied: missing.length === 0,
		missing,
	};
}

export function buildRows(
	scope: Array<{ id: string } & ForestNode>,
	ctx: Ctx,
	evidenceKind: EvidenceKind = "unknown",
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
				// 结构性 unknown：纪律规定如此，不是缺口。分类声明让对外读账本时
				// 不会把「决策类节点没有可计数指标」误读成「部件没人用」。
				unknownClass: "structural" as const,
				why: "决策/实验/修复类：无 stats 或事件可引，按纪律 2 停在 unknown",
			};
		}
		const reading = probe.read?.(ctx) ?? { value: null, samples: 0 };
		// t0 之前一律 unknown，但 measured 值照常显示——看得见 15 条自举事件，
		// 又不让它推动 fit，这正是 authored / measured 分列的用处。
		const usable = started && reading.samples > 0;
		// 人类认可类指标（requires: natural）：脚本或模型运行安排的手势不是人的
		// 判断，读数只会收敛到脚本常数。与 t0 门同理——值照常显示，不推动 fit。
		const needsHuman =
			probe.requires === "natural" && evidenceKind !== "natural";
		const fit: Fit =
			!usable || needsHuman
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
			// 部件有可观测指标却停在 unknown，是证据缺口而不是结构性 unknown：
			// 东西建出来了，样本没攒够，或来源不是自然使用。处置结论（如果有）
			// 说明这行怎么样才算有结论。
			unknownClass: fit === "unknown" ? ("evidence-gap" as const) : undefined,
			disposition: fit === "unknown" ? probe.disposition : undefined,
			why: !started
				? "t0 未开始：.workbench 无真实线程或无注册写者，现有事件是自举期数据，不作样本"
				: reading.samples === 0
					? `insufficient-history：${probe.source} 无样本`
					: needsHuman
						? `来源 ${evidenceKind} 不是自然使用：实测 ${reading.value} 只反映脚本或模型运行安排的复核手势，不构成用户认可，fit 停在 unknown；来源 ${probe.source}`
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
			// present 终于对齐自己的阈值文本：block（真实）+ seal.reviews.correct
			// （正确），后者由人工复核 seal.reviewed 折出。校准闭环接入前的
			// 实现只数了前半句。
			source: "stats.seal.blocked + stats.seal.reviews.correct",
			value: stats.seal.blocked,
			present: stats.seal.blocked >= 1 && stats.seal.reviews.correct >= 1,
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
