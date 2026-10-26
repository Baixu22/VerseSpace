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
 * - The failure class decides the action, not the status code alone:
 *   - bad_request: adapt the request if a parameter can change, else fail.
 *   - rate, overloaded, server, timeout, network, stream: retry the same
 *     target with backoff, then switch to the next target.
 *   - quota, auth, model_missing, context_overflow: switch at once. Retrying
 *     the same target cannot help.
 *   - content_filter, malformed: fail. No target changes the answer.
 * - A target that keeps failing is moved behind healthy targets for a short
 *   cooldown. It is never removed, so the plan can always fall back to it.
 */

import type { AdaptationTarget, ModelAdaptation } from "./model-adaptation";
import { type FailureKind, kindFromStatus } from "./protocols";

export interface AttemptOutcome {
	ok: boolean;
	/** HTTP status when the upstream answered; undefined for network/stream failures. */
	status?: number;
	/** Human-readable failure, already safe to show (no secrets). */
	message?: string;
	/** Failure class from the protocol layer. Preferred over `status`. */
	kind?: FailureKind;
	/** True once any text delta has been delivered to the user. */
	emittedOutput: boolean;
	/**
	 * Legacy hint for failures without a `kind`: false marks the failure as
	 * definitive (for example a malformed frame).
	 */
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
	failure?: FailureKind;
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

/** Failures a retry on the same target can plausibly fix. */
const RETRYABLE: ReadonlySet<FailureKind> = new Set<FailureKind>([
	"rate",
	"overloaded",
	"server",
	"timeout",
	"network",
	"stream",
]);

/** Failures where this target is the wrong choice, but another may succeed. */
const SWITCHABLE: ReadonlySet<FailureKind> = new Set<FailureKind>([
	"quota",
	"auth",
	"model_missing",
	"context_overflow",
]);

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

/**
 * Failure class for an attempt. An explicit `failure` from the protocol layer
 * wins; otherwise the class is inferred from the status, with `transient`
 * kept as the legacy signal for failures that have neither.
 */
export function failureKindOf(input: {
	failure?: FailureKind;
	status?: number;
	transient?: boolean;
}): FailureKind {
	if (input.failure) return input.failure;
	if (input.status !== undefined) return kindFromStatus(input.status);
	// No status = no HTTP answer. Retryable unless the lane said otherwise.
	return input.transient === false ? "malformed" : "network";
}

export function decideAfterFailure(input: PolicyInput): FailoverDecision {
	if (input.emittedOutput) return { kind: "fail" };

	const kind = failureKindOf(input);

	if (kind === "bad_request") {
		return input.adapted ? { kind: "adapt" } : { kind: "fail" };
	}

	if (RETRYABLE.has(kind)) {
		if (input.attempt < input.maxAttempts) {
			return {
				kind: "retry",
				delayMs: retryDelayMs(input.attempt, input.retryAfterMs, input.random),
			};
		}
		return input.hasNextTarget ? { kind: "failover" } : { kind: "fail" };
	}

	if (SWITCHABLE.has(kind)) {
		return input.hasNextTarget ? { kind: "failover" } : { kind: "fail" };
	}

	// content_filter, malformed, and anything unclassified.
	return { kind: "fail" };
}

export interface PlannedTarget extends AdaptationTarget {
	/** Resolved credential. Empty means the target cannot be called. */
	apiKey: string;
	label: string;
}

export function targetKey(target: AdaptationTarget): string {
	return `${target.provider}\u0000${target.model}\u0000${target.baseUrl}`;
}

/** Primary first, then fallbacks in order, with identical endpoints collapsed. */
export function buildAttemptPlan(targets: PlannedTarget[]): PlannedTarget[] {
	const seen = new Set<string>();
	const plan: PlannedTarget[] = [];
	for (const target of targets) {
		const key = targetKey(target);
		if (seen.has(key)) continue;
		seen.add(key);
		plan.push(target);
	}
	return plan;
}

export interface TargetHealthOptions {
	/** Consecutive abandoned targets before cooldown starts. */
	threshold?: number;
	cooldownMs?: number;
	now?: () => number;
}

/**
 * Process-local, in-memory cooldown per target. Not shared across instances,
 * and not persisted: a restart forgets it, which is the safe default.
 */
export class TargetHealth {
	private readonly state = new Map<
		string,
		{ failures: number; coolingUntil: number }
	>();
	private readonly threshold: number;
	private readonly cooldownMs: number;
	private readonly now: () => number;

	constructor(options: TargetHealthOptions = {}) {
		this.threshold = options.threshold ?? 2;
		this.cooldownMs = options.cooldownMs ?? 60_000;
		this.now = options.now ?? Date.now;
	}

	isCoolingDown(target: AdaptationTarget): boolean {
		const entry = this.state.get(targetKey(target));
		return entry !== undefined && entry.coolingUntil > this.now();
	}

	/** Called when a target was abandoned for the turn. */
	recordFailure(target: AdaptationTarget): void {
		const key = targetKey(target);
		const entry = this.state.get(key) ?? { failures: 0, coolingUntil: 0 };
		entry.failures += 1;
		if (entry.failures >= this.threshold) {
			entry.coolingUntil = this.now() + this.cooldownMs;
		}
		this.state.set(key, entry);
	}

	recordSuccess(target: AdaptationTarget): void {
		this.state.delete(targetKey(target));
	}

	/** Healthy targets first, cooling ones last, each group in configured order. */
	order<T extends AdaptationTarget>(targets: T[]): T[] {
		const healthy = targets.filter((t) => !this.isCoolingDown(t));
		const cooling = targets.filter((t) => this.isCoolingDown(t));
		return [...healthy, ...cooling];
	}
}

export interface FailoverResult<T> {
	ok: boolean;
	target?: PlannedTarget;
	value?: T;
	/** Total upstream requests made, including retries and adaptations. */
	attempts: number;
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
	health?: TargetHealth;
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
	let attempts = 0;
	const plan = options.health
		? options.health.order(options.targets)
		: options.targets;

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
			attempts += 1;
			const body = options.adaptation.adjust(target, options.buildBody(target));
			let outcome: AttemptOutcome & { value?: T };
			try {
				outcome = await options.send(target, body);
			} catch (error) {
				if (options.signal?.aborted) throw error;
				outcome = {
					ok: false,
					kind: "network",
					emittedOutput: false,
					message: error instanceof Error ? error.message : String(error),
				};
			}
			if (outcome.ok) {
				options.health?.recordSuccess(target);
				return { ok: true, target, value: outcome.value, attempts, failures };
			}

			const message = outcome.message ?? "上游请求失败";
			const failure = failureKindOf({
				failure: outcome.kind,
				status: outcome.status,
				transient: outcome.transient,
			});
			let adapted = false;
			if (
				failure === "bad_request" &&
				adaptations < MAX_ADAPTATIONS_PER_TARGET
			) {
				adapted = options.adaptation.learn(target, body, message) !== null;
				if (adapted) adaptations += 1;
			}

			const decision = decideAfterFailure({
				status: outcome.status,
				failure: outcome.kind,
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
				attempts -= 1;
				continue;
			}
			if (decision.kind === "retry") {
				failures.push({ label: target.label, message });
				await sleep(decision.delayMs);
				continue;
			}
			failures.push({ label: target.label, message });
			if (decision.kind === "failover") {
				options.health?.recordFailure(target);
				switchTarget = true;
				continue;
			}
			// fail: stop the whole chain. Output already delivered, or a
			// request-level error that every target would reject.
			return { ok: false, attempts, failures };
		}
	}

	return { ok: false, attempts, failures };
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
