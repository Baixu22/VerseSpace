import type { Blackboard } from "../blackboard";

/**
 * WIP by derivation, not by configuration (R3 / TF-0083).
 *
 * drum-buffer-rope: the reviewer is the drum. A system that starts work
 * faster than a human can review it does not get faster — it gets a backlog,
 * and a backlog is where context rots. So the number of lanes that may be
 * started is not a number anyone picks; it is Little's Law applied to what
 * the system actually does:
 *
 *     L = λ × W
 *
 * where λ is the observed completion rate (items per hour) and W is the
 * observed mean residence time (minutes from dispatch to done). Everything
 * on the right is measured, so L is a conclusion, not a preference.
 *
 * The limit is enforced as CONWIP — one global token pool, not per-stage
 * limits. Per-stage limits optimize each stage locally and starve the drum;
 * a single pool is the only shape that actually bounds the queue in front of
 * the constraint.
 *
 * When there is not enough history to derive anything, this module says so
 * instead of inventing a number: `basis: "insufficient-history"` and the
 * limit falls back to the physical bound (how many workspots exist). A
 * derived-looking number with no measurement behind it is worse than an
 * admitted guess.
 */

/** Below this many completed items, λ × W is noise. */
export const MIN_SAMPLES = 3;
/** The observation window for the completion rate. */
export const OBSERVATION_WINDOW_MS = 24 * 60 * 60_000;
/** A residence time longer than this is an abandoned lane, not a slow one. */
export const MAX_RESIDENCE_MINUTES = 8 * 60;

export type WipBasis = "little-law" | "insufficient-history";

export interface FlowSample {
	goalId: string;
	residenceMinutes: number;
	completedAt: string;
}

export interface FlowObservations {
	/** Window the rate was measured over. */
	windowMinutes: number;
	samples: FlowSample[];
	completed: number;
	throughputPerHour: number;
	meanResidenceMinutes: number;
	/** The derived WIP ceiling. */
	wipLimit: number;
	basis: WipBasis;
	/** Work that has entered and not yet left the system. */
	inFlight: number;
	/**
	 * The one number that is genuinely shared across every lane (TF-0084):
	 * produced work that no human has looked at yet. Everything else on a
	 * lane card is that lane's own business.
	 */
	unreviewedBacklog: number;
	tokensFree: number;
	/** Physical bound, used when history is too thin to derive from. */
	workspots: number;
}

/**
 * Little's Law, in the units the blackboard stores. Rounded up: a limit of
 * 2.1 means two lanes and a bit, and "a bit" is not a lane — but rounding
 * DOWN would silently make the derived limit the binding constraint on a
 * system that has demonstrated it can handle more.
 */
export function littleLawWip(
	throughputPerHour: number,
	meanResidenceMinutes: number,
): number {
	if (
		!Number.isFinite(throughputPerHour) ||
		!Number.isFinite(meanResidenceMinutes)
	) {
		return 1;
	}
	if (throughputPerHour <= 0 || meanResidenceMinutes <= 0) {
		return 1;
	}
	return Math.max(
		1,
		Math.ceil((throughputPerHour * meanResidenceMinutes) / 60),
	);
}

interface DispatchStamp {
	goalId: string;
	at: number;
}

/**
 * Join dispatches to completions. A goal dispatched twice (re-dispatched
 * after a reassignment) is measured from its LAST dispatch — the earlier run
 * produced nothing that finished.
 */
export function joinFlow(
	dispatches: DispatchStamp[],
	completions: DispatchStamp[],
	now: number,
	windowMs = OBSERVATION_WINDOW_MS,
): { samples: FlowSample[]; windowMinutes: number } {
	const lastDispatch = new Map<string, number>();
	for (const d of dispatches) {
		const previous = lastDispatch.get(d.goalId);
		if (previous === undefined || d.at > previous) {
			lastDispatch.set(d.goalId, d.at);
		}
	}
	const firstEvent = Math.min(
		now,
		...dispatches.map((d) => d.at),
		...completions.map((c) => c.at),
	);
	const windowMs_ = Math.min(windowMs, Math.max(0, now - firstEvent));
	const windowMinutes = Math.max(1, Math.round(windowMs_ / 60_000));

	const samples: FlowSample[] = [];
	for (const completion of completions) {
		const start = lastDispatch.get(completion.goalId);
		if (start === undefined || completion.at < start) {
			continue; // completed without a recorded dispatch: not a flow sample
		}
		if (completion.at < now - windowMs_) {
			continue; // outside the window
		}
		const minutes = (completion.at - start) / 60_000;
		if (minutes > MAX_RESIDENCE_MINUTES) {
			continue; // abandoned lane, not a slow one
		}
		samples.push({
			goalId: completion.goalId,
			residenceMinutes: minutes,
			completedAt: new Date(completion.at).toISOString(),
		});
	}
	return { samples, windowMinutes };
}

/** Read dispatch and completion stamps out of the event log. */
async function readStamps(
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

/**
 * Count work that has entered and not left: active lanes holding a goal, plus
 * produced work sitting in front of the drum.
 */
async function countInFlight(bb: Blackboard): Promise<{
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

/**
 * CONWIP admission. One question, one answer: is there a free token?
 *
 * `force` is the human override and is deliberately explicit and logged —
 * drum-buffer-rope has always allowed expediting, it just makes you say so.
 * The automatic scheduler never gets to force.
 */
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

/**
 * The one-sentence explanation a config view shows next to the number. The
 * point of TF-0083 is that this line exists at all: nobody typed the limit.
 */
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
