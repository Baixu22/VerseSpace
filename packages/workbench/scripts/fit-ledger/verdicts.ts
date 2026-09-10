/** TF-0136: observable thresholds, separate from permission to change scope. */
import { eventPayload } from "../../src/chat/stats-events";
import { sampleWindow, t0Started } from "./ledger";
import type { Ctx, EvidenceKind } from "./metrics";
import { EVIDENCE_KINDS } from "./metrics";

export { EVIDENCE_KINDS, type EvidenceKind };
export type VerdictStatus =
	| "supported"
	| "not-supported"
	| "insufficient-evidence";

export interface Verdict {
	id: "resume-card" | "premise-detection" | "stage-c" | "l3";
	title: string;
	status: VerdictStatus;
	action: string;
	readings: Array<{
		source: string;
		value: number | null;
		threshold: string;
	}>;
}

export function parseEvidenceKind(value: string): EvidenceKind {
	if (!EVIDENCE_KINDS.includes(value as EvidenceKind)) {
		throw new Error(`--evidence-kind 只接受 ${EVIDENCE_KINDS.join(" / ")}`);
	}
	return value as EvidenceKind;
}

export function assessVerdicts(ctx: Ctx, kind: EvidenceKind): Verdict[] {
	const { stats } = ctx;
	const ready =
		kind !== "unknown" && t0Started(ctx) && sampleWindow(ctx).satisfied;
	const verdict = (condition: boolean | null): VerdictStatus =>
		!ready || condition === null
			? "insufficient-evidence"
			: condition
				? "supported"
				: "not-supported";
	const { restores, resumeNotesConsumed, resumeActions } = stats.lifecycle;
	const consumption = restores > 0 ? resumeNotesConsumed / restores : null;
	const resume = verdict(
		consumption === null ? null : consumption >= 0.3 && resumeActions > 0,
	);

	const agent = stats.noticeOutcomes.agent;
	const ratio = (count: number): number | null =>
		agent.delivered > 0 ? count / agent.delivered : null;
	const dismissed = ratio(agent.dismissed);
	const ignored = ratio(agent.ignored);
	const dismissedUpper = ratio(agent.dismissed + agent.unknown);
	const ignoredUpper = ratio(agent.ignored + agent.unknown);
	// Unknown deliveries might still become dismissals or blind writes. A low
	// observed ratio only supports the threshold when even that upper bound fits.
	const detection = verdict(
		dismissed === null || ignored === null
			? null
			: dismissed > 0.5 || ignored > 0.1
				? false
				: dismissedUpper! > 0.5 || ignoredUpper! > 0.1
					? null
					: true,
	);

	const inheritedThreads = new Set<string>();
	let factsConsumed = 0;
	for (const event of ctx.events) {
		const payload = eventPayload(event);
		if (
			event.type === "thread.inheritance_observed" &&
			typeof payload.threadId === "string" &&
			payload.agentContextInherited === true &&
			payload.premiseInherited === true
		) {
			inheritedThreads.add(payload.threadId);
		}
		if (
			event.type === "thread.resume_action" &&
			(payload.action === "resume_fact_opened" ||
				payload.action === "resume_branch_opened")
		) {
			factsConsumed += 1;
		}
	}
	const stageC = verdict(
		stats.forks.total < 5 ? false : inheritedThreads.size > 0 ? true : null,
	);
	const days = stats.observation.days;
	const factsPerWeek = days >= 7 ? factsConsumed / (days / 7) : null;
	const cadence = days >= 7 ? stats.forks.total / (days / 7) : null;
	const siblings = stats.siblingAlternation;
	const alternation =
		siblings.available && siblings.families > 0
			? siblings.alternatingFamilies / siblings.families
			: null;
	// Scripted gestures, including live-model scenarios, cannot establish human
	// demand for L3. Calendar span never blocks engineering work above.
	const l3 =
		kind !== "natural" || days < 14
			? "insufficient-evidence"
			: verdict(
					cadence === null || alternation === null || factsPerWeek === null
						? null
						: cadence >= 1 && alternation >= 0.3 && factsPerWeek >= 1,
				);

	return [
		{
			id: "resume-card",
			title: "判决一：恢复卡",
			status: resume,
			action:
				resume === "supported"
					? "保留现有恢复卡；工程场景中的消费不等于自然用户认可或耗时改善。"
					: "保留现状，复核恢复与消费记录；达到使用证据要求后再判断是否缩为纯事实行。",
			readings: [
				{
					source:
						"stats.lifecycle.resumeNotesConsumed / stats.lifecycle.restores",
					value: consumption,
					threshold: "≥ 0.3",
				},
				{
					source: "stats.lifecycle.resumeActions",
					value: resumeActions,
					threshold: "> 0",
				},
			],
		},
		{
			id: "premise-detection",
			title: "判决二：前提检测",
			status: detection,
			action:
				detection === "supported"
					? "现有检测满足本现场阈值，继续采样。"
					: detection === "not-supported"
						? "已有负样本超过阈值；先校准检测与归因，再评估是否需要 import 可达性谓词。"
						: "补通知后的可观测活动；unknown 不能当作未忽略或未驳回。",
			readings: [
				{
					source: "stats.noticeOutcomes.agent.delivered",
					value: agent.delivered,
					threshold: "> 0",
				},
				{
					source: "stats.noticeOutcomes.agent.dismissed / .delivered",
					value: dismissed,
					threshold: "≤ 0.5",
				},
				{
					source: "stats.noticeOutcomes.agent.ignored / .delivered",
					value: ignored,
					threshold: "≤ 0.1",
				},
				{
					source: "stats.noticeOutcomes.agent.unknown",
					value: agent.unknown,
					threshold: "保留为未知",
				},
				{
					source:
						"(stats.noticeOutcomes.agent.dismissed + .unknown) / .delivered",
					value: dismissedUpper,
					threshold: "≤ 0.5 才足以支持判据",
				},
				{
					source:
						"(stats.noticeOutcomes.agent.ignored + .unknown) / .delivered",
					value: ignoredUpper,
					threshold: "≤ 0.1 才足以支持判据",
				},
			],
		},
		{
			id: "stage-c",
			title: "判决三：阶段 C",
			status: stageC,
			action:
				stageC === "supported"
					? "保留已完成的阶段 C；继续回归分叉继承、通知与封印。"
					: "阶段 C 已完成；本现场尚不足以重复支持范围判据，继续补分叉与真实继承观测。",
			readings: [
				{
					source: "stats.forks.total",
					value: stats.forks.total,
					threshold: "≥ 5",
				},
				{
					source:
						"events[thread.inheritance_observed]：agentContextInherited && premiseInherited，按 threadId 去重（TF-0125/0131）",
					value: inheritedThreads.size,
					threshold: "≥ 1",
				},
			],
		},
		{
			id: "l3",
			title: "判决四：L3",
			status: l3,
			action:
				l3 === "supported"
					? "仅达到复评门槛；核对自然使用来源与 N=2 可重放轨迹，再决定是否开工。"
					: "继续延后 L3 复评：TF-0099 / TF-0100 / TF-0101 已于 2026-09-09 废止（docs/tf0136-l3-cut-verdict.md），本判据只记录自然使用是否曾达门槛；工程开发照常推进。",
			readings: [
				{
					source: "stats.observation.days（仅时间跨度，来源须另行核对）",
					value: days,
					threshold: "自然使用且 ≥ 14 天",
				},
				{
					source: "stats.forks.total / (stats.observation.days / 7)",
					value: cadence,
					threshold: "≥ 1",
				},
				{
					source:
						"stats.siblingAlternation.alternatingFamilies / .families（全部根家族为分母，TF-0122）",
					value: alternation,
					threshold: "≥ 0.3",
				},
				{
					source:
						"events[thread.resume_action]：resume_fact_opened / resume_branch_opened（TF-0129/0151）",
					value: factsPerWeek,
					threshold: "≥ 1 / 周；dismiss 与叙事展开不计事实消费",
				},
			],
		},
	];
}
