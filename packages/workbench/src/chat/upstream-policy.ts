/**
 * Stability policy for the HTTP lane: what to do after one upstream attempt
 * fails, and in which order targets are tried.
 *
 * The orchestrator is deliberately free of I/O. It receives a `send` function
 * for one attempt against one target, so the decision table can be tested
 * without a network, and the HTTP lane supplies the real fetch.
 *
 * Hard rules:
 * - Once any output has reached the user, the turn never retries or switches.
 *   Two upstreams' answers must not be stitched together.
 * - 400/422 is only retried when the adaptation layer can change the request.
 * - 401/403 switch to the next target (a different key may work) but are not
 *   retried on the same target.
 * - Other 4xx are request bugs; every target would reject them, so they fail.
 */

import type { AdaptationTarget, ModelAdaptation } from "./model-adaptation";

export interface AttemptOutcome {
	ok: boolean;
	/** HTTP status when the upstream answered; undefined for network/stream failures. */
	status?: number;
	/** Human-readable failure, already safe to show (no secrets). */
	message?: string;
	/** True once any text delta has been delivered to the user. */
	emittedOutput: boolean;
	/** Set by the lane when the stream failed with a recognised transient error. */
	transient?: boolean;
	retryAfterMs?: number;
}

export type FailoverDecision =
	| { kind: "adapt" }
	| { kind: "retry"; delayMs: number }
	| { kind: "failover" }
	| { kind: "fail" };

export interface PolicyInput {
	status?: number;
	emittedOutput: boolean;
	transient?: boolean;
	/** Attempts already made on this target, counting the one that just failed. */
	attempt: number;
	maxAttempts: number;
	hasNextTarget: boolean;
	/** Whether the adaptation layer learned something for this rejection. */
	adapted: boolean;
	retryAfterMs?: number;
	random?: () => number;
}

const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 4_000;
const RETRY_AFTER_CAP_MS = 10_000;

/** Exponential backoff with jitter. A server Retry-After is honoured up to a cap. */
export function retryDelayMs(
	attempt: number,
	retryAfterMs?: number,
	random: () => number = Math.random,
): number {
	if (retryAfterMs !== undefined && retryAfterMs >= 0) {
		return Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
	}
	const exp = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
	return Math.round(exp * (0.75 + random() * 0.5));
}

export function decideAfterFailure(input: PolicyInput): FailoverDecision {
	if (input.emittedOutput) return { kind: "fail" };

	if (input.status === 400 || input.status === 422) {
		return input.adapted ? { kind: "adapt" } : { kind: "fail" };
	}

	// No status = the request never produced an HTTP answer (network error, cut
	// stream). It is retryable unless the lane has said the failure is definitive
	// (for example a malformed frame), so `transient: false` always wins.
	const noAnswer = input.status === undefined && input.transient !== false;
	const transientStatus =
		input.status === 408 ||
		input.status === 425 ||
		input.status === 429 ||
		(input.status !== undefined && input.status >= 500);
	if (noAnswer || transientStatus) {
		if (input.attempt < input.maxAttempts) {
			return {
				kind: "retry",
				delayMs: retryDelayMs(input.attempt, input.retryAfterMs, input.random),
			};
		}
		return input.hasNextTarget ? { kind: "failover" } : { kind: "fail" };
	}

	if (input.status === 401 || input.status === 403) {
		return input.hasNextTarget ? { kind: "failover" } : { kind: "fail" };
	}
	return { kind: "fail" };
}

/** Phrases that mark an in-stream error as worth retrying rather than a bad request. */
const TRANSIENT_MESSAGE =
	/overload|rate.?limit|too many requests|timeout|timed out|temporar|unavailable|internal|try again|capacity/i;

export function isTransientStreamError(message: string): boolean {
	return TRANSIENT_MESSAGE.test(message);
}

export interface PlannedTarget extends AdaptationTarget {
	/** Resolved credential. Empty means the target cannot be called. */
	apiKey: string;
	label: string;
}

/** Primary first, then fallbacks in order, with identical endpoints collapsed. */
export function buildAttemptPlan(targets: PlannedTarget[]): PlannedTarget[] {
	const seen = new Set<string>();
	const plan: PlannedTarget[] = [];
	for (const target of targets) {
		const key = `${target.provider}\u0000${target.model}\u0000${target.baseUrl}`;
		if (seen.has(key)) continue;
		seen.add(key);
		plan.push(target);
	}
	return plan;
}

export interface FailoverResult<T> {
	ok: boolean;
	target?: PlannedTarget;
	value?: T;
	/** Every failure in order, for a summary the user can act on. */
	failures: Array<{ label: string; message: string }>;
}

export interface FailoverOptions<T> {
	targets: PlannedTarget[];
	maxAttempts: number;
	adaptation: ModelAdaptation;
	/** Builds the body for a target; the orchestrator never sees the wire format. */
	buildBody: (target: PlannedTarget) => Record<string, unknown>;
	send: (
		target: PlannedTarget,
		body: Record<string, unknown>,
	) => Promise<AttemptOutcome & { value?: T }>;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	signal?: AbortSignal;
}

const MAX_ADAPTATIONS_PER_TARGET = 3;

export async function runWithFailover<T>(
	options: FailoverOptions<T>,
): Promise<FailoverResult<T>> {
	const sleep =
		options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const failures: Array<{ label: string; message: string }> = [];
	const plan = options.targets;

	for (let index = 0; index < plan.length; index++) {
		const target = plan[index]!;
		const hasNextTarget = index < plan.length - 1;
		if (!target.apiKey) {
			failures.push({
				label: target.label,
				message: "未配置 API Key，已跳过该目标",
			});
			continue;
		}

		let attempt = 0;
		let adaptations = 0;
		let switchTarget = false;
		while (!switchTarget) {
			if (options.signal?.aborted) {
				throw new DOMException("aborted", "AbortError");
			}
			attempt += 1;
			const body = options.adaptation.adjust(target, options.buildBody(target));
			let outcome: AttemptOutcome & { value?: T };
			try {
				outcome = await options.send(target, body);
			} catch (error) {
				if (options.signal?.aborted) throw error;
				outcome = {
					ok: false,
					emittedOutput: false,
					message: error instanceof Error ? error.message : String(error),
				};
			}
			if (outcome.ok) {
				return { ok: true, target, value: outcome.value, failures };
			}

			const message = outcome.message ?? "上游请求失败";
			let adapted = false;
			if (
				(outcome.status === 400 || outcome.status === 422) &&
				adaptations < MAX_ADAPTATIONS_PER_TARGET
			) {
				adapted = options.adaptation.learn(target, body, message) !== null;
				if (adapted) adaptations += 1;
			}

			const decision = decideAfterFailure({
				status: outcome.status,
				emittedOutput: outcome.emittedOutput,
				transient: outcome.transient,
				attempt,
				maxAttempts: options.maxAttempts,
				hasNextTarget,
				adapted,
				retryAfterMs: outcome.retryAfterMs,
				random: options.random,
			});

			if (decision.kind === "adapt") {
				// Same target, same attempt budget: the request changed, not the odds.
				attempt -= 1;
				continue;
			}
			if (decision.kind === "retry") {
				failures.push({ label: target.label, message });
				await sleep(decision.delayMs);
				continue;
			}
			failures.push({ label: target.label, message });
			if (decision.kind === "failover") {
				switchTarget = true;
				continue;
			}
			// fail: stop the whole chain. Output already delivered, or a
			// request-level error that every target would reject.
			return { ok: false, failures };
		}
	}

	return { ok: false, failures };
}

/** One readable line per failure, for the final error shown to the user. */
export function summariseFailures(
	failures: Array<{ label: string; message: string }>,
): string {
	if (failures.length === 0) return "没有可用的模型目标";
	if (failures.length === 1) return failures[0]!.message;
	return failures
		.map((f) => `${f.label}：${f.message}`)
		.join("；")
		.slice(0, 600);
}
