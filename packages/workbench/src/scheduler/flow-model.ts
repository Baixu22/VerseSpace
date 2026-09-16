export const MIN_SAMPLES = 3;

export const OBSERVATION_WINDOW_MS = 24 * 60 * 60_000;

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

export interface DispatchStamp {
	goalId: string;
	at: number;
}

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
