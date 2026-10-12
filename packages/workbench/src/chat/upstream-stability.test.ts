import { describe, expect, test } from "bun:test";
import { makeTempWorkbench } from "../test/fixtures";
import { workbenchConfigSchema } from "../types/config";
import { ModelAdaptation } from "./model-adaptation";
import type { RunEvent } from "./thread-types";
import { ChatThreads } from "./threads";
import {
	type AttemptOutcome,
	type PlannedTarget,
	runWithFailover,
	TargetHealth,
} from "./upstream-policy";

const sse = (...frames: unknown[]) =>
	new Response(
		frames
			.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream", connection: "close" } },
	);

interface Seen {
	path: string;
	search: string;
	body: Record<string, unknown>;
}

function fakeUpstream(
	script: Array<() => Response | Promise<Response>>,
	seen: Seen[],
) {
	return Bun.serve({
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as Record<string, unknown>;
			const url = new URL(request.url);
			seen.push({ path: url.pathname, search: url.search, body });
			const next = script.shift();
			if (!next) return new Response("unscripted", { status: 599 });
			return next();
		},
	});
}

async function withWorkbench(
	chat: Record<string, unknown>,
	fn: (threads: ChatThreads) => Promise<void>,
) {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.config.save(workbenchConfigSchema.parse({ chat }));
		await fn(new ChatThreads(ws.bb));
	} finally {
		await ws.cleanup();
	}
}

async function runTurn(threads: ChatThreads, text: string) {
	const thread = await threads.create("稳定性验证");
	const events: RunEvent[] = [];
	await threads.run(thread.id, text, (event) => events.push(event));
	const errors = events
		.filter((e) => e.type === "error")
		.map((e) => (e as { message: string }).message);
	const messages = await threads.messages(thread.id);
	return { thread, errors, reply: messages.at(-1)?.text ?? "" };
}

const target = (label: string, baseUrl = "http://x"): PlannedTarget => ({
	provider: "openai-chat",
	model: label,
	baseUrl,
	apiKey: "k",
	label,
});

describe("per-target cooldown", () => {
	test("a target abandoned twice is tried last, then recovers after the cooldown", async () => {
		let clock = 0;
		const health = new TargetHealth({
			threshold: 2,
			cooldownMs: 1000,
			now: () => clock,
		});
		const primary = target("primary");
		const backup = target("backup", "http://y");
		const calls: string[] = [];
		const send = async (
			t: PlannedTarget,
		): Promise<AttemptOutcome & { value?: string }> => {
			calls.push(t.label);
			if (t.label === "primary") {
				return {
					ok: false,
					kind: "auth",
					emittedOutput: false,
					message: "401",
				};
			}
			return { ok: true, emittedOutput: false, value: "ok" };
		};
		const run = () =>
			runWithFailover<string>({
				targets: [primary, backup],
				maxAttempts: 1,
				adaptation: new ModelAdaptation(),
				buildBody: () => ({}),
				send,
				health,
			});

		await run();
		await run();
		expect(calls).toEqual(["primary", "backup", "primary", "backup"]);

		// Cooling down: the primary is no longer first, so it is not even tried.
		calls.length = 0;
		await run();
		expect(calls).toEqual(["backup"]);

		// Cooldown over: the primary gets another chance.
		clock = 2000;
		calls.length = 0;
		await run();
		expect(calls[0]).toBe("primary");
	});

	test("a success clears the failure count", () => {
		const health = new TargetHealth({ threshold: 2, now: () => 0 });
		const t = target("a");
		health.recordFailure(t);
		health.recordSuccess(t);
		health.recordFailure(t);
		expect(health.isCoolingDown(t)).toBe(false);
	});

	test("cooling targets are moved behind, never dropped", () => {
		const health = new TargetHealth({ threshold: 1, now: () => 0 });
		const a = target("a");
		const b = target("b", "http://y");
		health.recordFailure(a);
		expect(health.order([a, b]).map((t) => t.label)).toEqual(["b", "a"]);
		expect(health.order([a]).map((t) => t.label)).toEqual(["a"]);
	});
});

describe("failure classes decide the action", () => {
	test("quota switches at once: retrying the same account cannot help", async () => {
		const calls: string[] = [];
		const result = await runWithFailover<string>({
			targets: [target("a"), target("b", "http://y")],
			maxAttempts: 3,
			adaptation: new ModelAdaptation(),
			buildBody: () => ({}),
			send: async (t) => {
				calls.push(t.label);
				if (t.label === "a") {
					return {
						ok: false,
						kind: "quota",
						status: 429,
						emittedOutput: false,
						message: "quota",
					};
				}
				return { ok: true, emittedOutput: false, value: "ok" };
			},
		});
		expect(result.ok).toBe(true);
		expect(calls).toEqual(["a", "b"]);
		expect(result.attempts).toBe(2);
	});

	test("content_filter fails the chain: no other target changes the answer", async () => {
		const calls: string[] = [];
		const result = await runWithFailover<string>({
			targets: [target("a"), target("b", "http://y")],
			maxAttempts: 3,
			adaptation: new ModelAdaptation(),
			buildBody: () => ({}),
			send: async (t) => {
				calls.push(t.label);
				return {
					ok: false,
					kind: "content_filter",
					emittedOutput: false,
					message: "policy",
				};
			},
		});
		expect(result.ok).toBe(false);
		expect(calls).toEqual(["a"]);
	});
});

describe("HTTP lane against a real upstream", () => {
	test("a stalled primary times out and the fallback answers", async () => {
		const seenA: Seen[] = [];
		const seenB: Seen[] = [];
		const stalled = Bun.serve({
			port: 0,
			async fetch(request) {
				await request.json();
				// Never answer: the idle watchdog must cut this off.
				return new Promise<Response>(() => {});
			},
		});
		const fallback = fakeUpstream(
			[
				() =>
					sse(
						{ choices: [{ delta: { content: "备用" } }] },
						{ choices: [{ delta: {}, finish_reason: "stop" }] },
						"[DONE]",
					),
			],
			seenB,
		);
		try {
			await withWorkbench(
				{
					provider: "openai-chat",
					model: "gpt-4o-mini",
					apiKey: "primary-key",
					baseUrl: `http://127.0.0.1:${stalled.port}/v1`,
					timeoutMs: 1000,
					maxAttempts: 1,
					fallbacks: [
						{
							provider: "openai-chat",
							model: "gpt-4o-mini",
							apiKey: "fallback-key",
							baseUrl: `http://127.0.0.1:${fallback.port}/v1`,
						},
					],
				},
				async (threads) => {
					const started = Date.now();
					const { errors, reply, thread } = await runTurn(threads, "你好");
					expect(Date.now() - started).toBeLessThan(10_000);
					expect(errors).toEqual([]);
					expect(reply).toBe("备用");
					expect(seenB).toHaveLength(1);
					const meta = await threads.get(thread.id);
					expect(meta.lastRun?.attempts).toBe(2);
					expect(meta.lastRun?.switchedFrom).toBe("openai-chat/gpt-4o-mini");
				},
			);
		} finally {
			stalled.stop(true);
			fallback.stop(true);
		}
		expect(seenA).toHaveLength(0);
	}, 20_000);

	test("cache usage from the provider is recorded on the thread", async () => {
		const seen: Seen[] = [];
		const upstream = fakeUpstream(
			[
				() =>
					sse(
						{ choices: [{ delta: { content: "好" } }] },
						{ choices: [{ delta: {}, finish_reason: "stop" }] },
						{
							choices: [],
							usage: {
								prompt_tokens: 2048,
								completion_tokens: 3,
								prompt_tokens_details: { cached_tokens: 1920 },
							},
						},
						"[DONE]",
					),
			],
			seen,
		);
		try {
			await withWorkbench(
				{
					provider: "openai-chat",
					model: "gpt-4o-mini",
					apiKey: "k",
					baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
				},
				async (threads) => {
					const { thread, reply } = await runTurn(threads, "缓存");
					expect(reply).toBe("好");
					// The request asked for usage, otherwise the hit rate is invisible.
					expect(seen[0]!.body.stream_options).toEqual({ include_usage: true });
					const meta = await threads.get(thread.id);
					expect(meta.lastRun?.usage).toEqual({
						promptTokens: 2048,
						cachedTokens: 1920,
						cacheWriteTokens: 0,
						outputTokens: 3,
					});
				},
			);
		} finally {
			upstream.stop(true);
		}
	});
});
