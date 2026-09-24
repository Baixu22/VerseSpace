import type { Blackboard } from "../blackboard";
import type { DispatchStamp, FlowObservations, WipBasis } from "./flow-model";
import { joinFlow, littleLawWip, MIN_SAMPLES } from "./flow-model";

export async function readStamps(
	bb: Blackboard,
): Promise<{ dispatches: DispatchStamp[]; completions: DispatchStamp[] }> {
	const events = await bb.events.all();
	const dispatches: DispatchStamp[] = [];
	const completions: DispatchStamp[] = [];
	for (const event of events) {
		const at = Date.parse(event.timestamp);
		if (!Number.isFinite(at)) {
			continue;
		}
		const payload = event.payload as Record<string, unknown> | undefined;
		if (event.type === "goal_dispatched") {
			const goalId = payload?.goalId;
			if (typeof goalId === "string") {
				dispatches.push({ goalId, at });
			}
			continue;
		}
		if (event.type === "goal_status") {
			const to = payload?.to;
			const goalId = payload?.goalId;
			if (to === "done" && typeof goalId === "string") {
				completions.push({ goalId, at });
			}
		}
	}
	return { dispatches, completions };
}

export async function countInFlight(bb: Blackboard): Promise<{
	inFlight: number;
	unreviewedBacklog: number;
	workspots: number;
}> {
	const workspots = (await bb.state.workspots.list()).length;
	const [goals, staging, verified] = await Promise.all([
		bb.goals.list(),
		bb.checkpoints.scanZone("staging"),
		bb.checkpoints.scanZone("verified"),
	]);
	// work the drum has not passed yet: anything in front of a human
	const awaitingReview =
		staging.filter((cp) => cp.lifecycle === "awaiting_review").length +
		verified.filter((cp) => cp.lifecycle === "awaiting_review").length;
	const inProgress = goals.filter(
		(goal) => goal.status === "in_progress",
	).length;
	const active = (await bb.state.workspots.list()).filter(
		(ws) => ws.status === "active",
	).length;
	return {
		inFlight: active + inProgress + awaitingReview,
		unreviewedBacklog: awaitingReview,
		workspots,
	};
}

export async function observeFlow(
	bb: Blackboard,
	now = Date.now(),
): Promise<FlowObservations> {
	const { dispatches, completions } = await readStamps(bb);
	const { samples, windowMinutes } = joinFlow(dispatches, completions, now);
	const { inFlight, unreviewedBacklog, workspots } = await countInFlight(bb);

	const completed = samples.length;
	const hours = windowMinutes / 60;
	const throughputPerHour = hours > 0 ? completed / hours : 0;
	const meanResidenceMinutes =
		completed === 0
			? 0
			: samples.reduce((sum, s) => sum + s.residenceMinutes, 0) / completed;

	const derived = completed >= MIN_SAMPLES;
	const wipLimit = derived
		? littleLawWip(throughputPerHour, meanResidenceMinutes)
		: Math.max(1, workspots);

	return {
		windowMinutes,
		samples,
		completed,
		throughputPerHour,
		meanResidenceMinutes,
		wipLimit,
		basis: derived ? "little-law" : "insufficient-history",
		inFlight,
		unreviewedBacklog,
		tokensFree: Math.max(0, wipLimit - inFlight),
		workspots,
	};
}

export interface Admission {
	allowed: boolean;
	/** Present when refused: why, in the drum's own numbers. */
	reason?: string;
	wipLimit: number;
	inFlight: number;
	tokensFree: number;
	basis: WipBasis;
	unreviewedBacklog: number;
}

export async function admitDispatch(
	bb: Blackboard,
	options: { force?: boolean } = {},
	now = Date.now(),
): Promise<Admission> {
	const flow = await observeFlow(bb, now);
	const base = {
		wipLimit: flow.wipLimit,
		inFlight: flow.inFlight,
		tokensFree: flow.tokensFree,
		basis: flow.basis,
		unreviewedBacklog: flow.unreviewedBacklog,
	};
	if (flow.tokensFree > 0 || options.force === true) {
		return { allowed: true, ...base };
	}
	const derived =
		flow.basis === "little-law"
			? `由 Little 定律推导（λ ${flow.throughputPerHour.toFixed(2)}/小时 × W ${Math.round(flow.meanResidenceMinutes)} 分钟）`
			: `观测样本不足 ${MIN_SAMPLES} 个，暂用物理上限（${flow.workspots} 个工位）`;
	return {
		allowed: false,
		reason:
			`WIP 已满：在制 ${flow.inFlight} / 上限 ${flow.wipLimit}（${derived}）。` +
			`未复核积压 ${flow.unreviewedBacklog} 项 —— 复核者是鼓点，先复核再开工。` +
			`确需插队用 --force。`,
		...base,
	};
}

export function explainWip(flow: FlowObservations): string {
	if (flow.basis === "insufficient-history") {
		const bound =
			flow.workspots === 0
				? "还没有工位，先按 1 条车道放行"
				: `暂用物理上限（${flow.workspots} 个工位）`;
		return `WIP 上限 ${flow.wipLimit}：观测到的完成数不足 ${MIN_SAMPLES} 个，暂无可推导的吞吐，${bound}`;
	}
	return (
		`WIP 上限 ${flow.wipLimit}：由 Little 定律推导 L = λ × W，` +
		`λ = ${flow.throughputPerHour.toFixed(2)} 项/小时（${flow.windowMinutes} 分钟内完成 ${flow.completed} 项），` +
		`W = ${Math.round(flow.meanResidenceMinutes)} 分钟`
	);
}

export type { FlowObservations, WipBasis } from "./flow-model";
export { joinFlow, littleLawWip, MIN_SAMPLES } from "./flow-model";
