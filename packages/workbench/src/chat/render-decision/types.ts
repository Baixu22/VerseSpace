/** Explicit rendering consequence for every Claude stream shape we accept. */
export type RenderDecision =
	| "finalized"
	| "streaming-delta"
	| "noop"
	/** User-actionable information the provider sent (see system-notice.ts). */
	| "notice";

export interface RenderVerdict {
	decision: RenderDecision;
	/** Stable, fixture-auditable event path. */
	key: string;
	reason: string;
}

export const verdict = (
	key: string,
	decision: RenderDecision,
	reason: string,
): RenderVerdict => ({ key, decision, reason });
