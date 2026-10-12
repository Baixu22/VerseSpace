import { expect, test } from "bun:test";
import { ModelAdaptation } from "./model-adaptation";
import {
	type AttemptOutcome,
	buildAttemptPlan,
	decideAfterFailure,
	isTransientStreamError,
	type PlannedTarget,
	retryDelayMs,
	runWithFailover,
	summariseFailures,
} from "./upstream-policy";

const base = {
	emittedOutput: false,
	attempt: 1,
	maxAttempts: 2,
	hasNextTarget: true,
	adapted: false,
} as const;

test("decision table: transient errors retry first, then switch", () => {
	expect(decideAfterFailure({ ...base, status: 503 }).kind).toBe("retry");
	expect(decideAfterFailure({ ...base, status: 429 }).kind).toBe("retry");
	expect(
		decideAfterFailure({ ...base, status: undefined, transient: true }).kind,
	).toBe("retry");
	expect(decideAfterFailure({ ...base, attempt: 2, status: 503 }).kind).toBe(
		"failover",
	);
	expect(
		decideAfterFailure({
			...base,
			attempt: 2,
			status: 503,
			hasNextTarget: false,
		}).kind,
	).toBe("fail");
});

test("decision table: auth errors switch targets without retrying the same one", () => {
	expect(decideAfterFailure({ ...base, status: 401 }).kind).toBe("failover");
	expect(decideAfterFailure({ ...base, status: 403 }).kind).toBe("failover");
	expect(
		decideAfterFailure({ ...base, status: 401, hasNextTarget: false }).kind,
	).toBe("fail");
});

test("decision table: bad requests fail unless adaptation changed the body", () => {
	expect(decideAfterFailure({ ...base, status: 400 }).kind).toBe("fail");
	expect(decideAfterFailure({ ...base, status: 400, adapted: true }).kind).toBe(
		"adapt",
	);
	expect(decideAfterFailure({ ...base, status: 404 }).kind).toBe("fail");
});

test("decision table: output already shown means never retry or switch", () => {
	for (const status of [503, 429, 401, undefined]) {
		expect(
			decideAfterFailure({
				...base,
				status,
				emittedOutput: true,
				transient: true,
			}).kind,
		).toBe("fail");
	}
});

test("a malformed stream is not transient; a cut stream is", () => {
	expect(
		decideAfterFailure({ ...base, status: undefined, transient: false }).kind,
	).toBe("fail");
	expect(isTransientStreamError("Overloaded, please try again")).toBe(true);
	expect(isTransientStreamError("messages.0.content: field required")).toBe(
		false,
	);
});

test("backoff grows, is capped, and honours Retry-After up to a ceiling", () => {
	const mid = () => 0.5;
	expect(retryDelayMs(1, undefined, mid)).toBe(500);
	expect(retryDelayMs(2, undefined, mid)).toBe(1000);
	expect(retryDelayMs(10, undefined, mid)).toBe(4000);
	expect(retryDelayMs(1, 2000, mid)).toBe(2000);
	expect(retryDelayMs(1, 600_000, mid)).toBe(10_000);
});

test("plan keeps primary first and drops identical endpoints", () => {
	const t = (label: string, model: string, baseUrl: string): PlannedTarget => ({
		provider: "openai-chat",
		model,
		baseUrl,
		apiKey: "k",
		label,
	});
	const plan = buildAttemptPlan([
		t("a", "m1", "https://x"),
		t("dup", "m1", "https://x"),
		t("b", "m2", "https://x"),
	]);
	expect(plan.map((p) => p.label)).toEqual(["a", "b"]);
});

const target = (
	label: string,
	provider: PlannedTarget["provider"] = "openai-chat",
): PlannedTarget => ({
	provider,
	model: "m",
	baseUrl: `https://${label}.test`,
	apiKey: "k",
	label,
});

function harness(
	script: Record<string, Array<AttemptOutcome & { value?: string }>>,
) {
	const calls: string[] = [];
	const sleeps: number[] = [];
	return {
		calls,
		sleeps,
		options: {
			maxAttempts: 2,
			adaptation: new ModelAdaptation(),
			buildBody: () => ({ model: "m", messages: [], temperature: 0.2 }),
			send: async (t: PlannedTarget) => {
				calls.push(t.label);
				const next = script[t.label]!.shift();
				if (!next) throw new Error(`unscripted call to ${t.label}`);
				return next;
			},
			sleep: async (ms: number) => {
				sleeps.push(ms);
			},
			random: () => 0.5,
		},
	};
}

test("retry on the same target, then fail over, then succeed", async () => {
	const h = harness({
		p: [
			{ ok: false, status: 503, message: "busy", emittedOutput: false },
			{ ok: false, status: 503, message: "busy", emittedOutput: false },
		],
		f: [{ ok: true, emittedOutput: true, value: "fallback answer" }],
	});
	const result = await runWithFailover({
		...h.options,
		targets: [target("p"), target("f")],
	});
	expect(h.calls).toEqual(["p", "p", "f"]);
	expect(h.sleeps).toEqual([500]);
	expect(result.ok).toBe(true);
	expect(result.target?.label).toBe("f");
	expect(result.value).toBe("fallback answer");
});

test("a learned parameter adapts the same target without spending a retry", async () => {
	const h = harness({
		p: [
			{
				ok: false,
				status: 400,
				message:
					"Unsupported value: 'temperature' does not support 0.2 with this model.",
				emittedOutput: false,
			},
			{ ok: true, emittedOutput: true, value: "ok" },
		],
	});
	const bodies: Array<Record<string, unknown>> = [];
	const result = await runWithFailover({
		...h.options,
		maxAttempts: 1,
		targets: [target("p")],
		send: async (t, body) => {
			bodies.push(body);
			return h.options.send(t);
		},
	});
	expect(result.ok).toBe(true);
	expect(bodies[0]).toHaveProperty("temperature");
	expect(bodies[1]).not.toHaveProperty("temperature");
	expect(h.sleeps).toEqual([]);
});

test("an unadaptable 400 stops the whole chain instead of trying every target", async () => {
	const h = harness({
		p: [
			{
				ok: false,
				status: 400,
				message: "invalid messages",
				emittedOutput: false,
			},
		],
	});
	const result = await runWithFailover({
		...h.options,
		targets: [target("p"), target("f")],
	});
	expect(result.ok).toBe(false);
	expect(h.calls).toEqual(["p"]);
});

test("a stream that already produced output is never switched", async () => {
	const h = harness({
		p: [
			{
				ok: false,
				status: undefined,
				transient: true,
				message: "cut",
				emittedOutput: true,
			},
		],
	});
	const result = await runWithFailover({
		...h.options,
		targets: [target("p"), target("f")],
	});
	expect(result.ok).toBe(false);
	expect(h.calls).toEqual(["p"]);
});

test("a target without a key is skipped, with a visible reason", async () => {
	const h = harness({ f: [{ ok: true, emittedOutput: true, value: "x" }] });
	const result = await runWithFailover({
		...h.options,
		targets: [{ ...target("p"), apiKey: "" }, target("f")],
	});
	expect(result.ok).toBe(true);
	expect(result.failures).toEqual([
		{ label: "p", message: "未配置 API Key，已跳过该目标" },
	]);
});

test("exhaustion reports every failure in order", async () => {
	const h = harness({
		p: [
			{ ok: false, status: 500, message: "p down", emittedOutput: false },
			{ ok: false, status: 500, message: "p down", emittedOutput: false },
		],
		f: [
			{ ok: false, status: 429, message: "f limited", emittedOutput: false },
			{ ok: false, status: 429, message: "f limited", emittedOutput: false },
		],
	});
	const result = await runWithFailover({
		...h.options,
		maxAttempts: 2,
		targets: [target("p"), target("f")],
	});
	expect(result.ok).toBe(false);
	expect(summariseFailures(result.failures)).toBe(
		"p：p down；p：p down；f：f limited；f：f limited",
	);
});

test("abort is not swallowed into a failover", async () => {
	const controller = new AbortController();
	controller.abort();
	const h = harness({});
	await expect(
		runWithFailover({
			...h.options,
			targets: [target("p")],
			signal: controller.signal,
		}),
	).rejects.toThrow();
	expect(h.calls).toEqual([]);
});
