import { expect, test } from "bun:test";
import { makeTempWorkbench } from "../test/fixtures";
import { workbenchConfigSchema } from "../types/config";
import type { RunEvent } from "./thread-types";
import { ChatThreads } from "./threads";

const openaiText = (text: string) =>
	new Response(
		`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
			`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
			"data: [DONE]\n\n",
		{ headers: { "content-type": "text/event-stream", connection: "close" } },
	);

const anthropicText = (text: string) =>
	new Response(
		`event: content_block_delta\ndata: ${JSON.stringify({
			type: "content_block_delta",
			delta: { type: "text_delta", text },
		})}\n\n` +
			`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
		{ headers: { "content-type": "text/event-stream", connection: "close" } },
	);

interface Seen {
	path: string;
	body: Record<string, unknown>;
}

/** A scripted upstream: each request consumes the next response in `script`. */
function fakeUpstream(script: Array<(seen: Seen) => Response>, seen: Seen[]) {
	return Bun.serve({
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as Record<string, unknown>;
			const entry = { path: new URL(request.url).pathname, body };
			seen.push(entry);
			const next = script.shift();
			if (!next) return new Response("unscripted", { status: 599 });
			return next(entry);
		},
	});
}

async function withWorkbench(
	chat: Record<string, unknown>,
	fn: (
		threads: ChatThreads,
		ws: Awaited<ReturnType<typeof makeTempWorkbench>>,
	) => Promise<void>,
) {
	const ws = await makeTempWorkbench();
	try {
		const config = workbenchConfigSchema.parse({ chat });
		await ws.bb.config.save(config);
		await fn(new ChatThreads(ws.bb), ws);
	} finally {
		await ws.cleanup();
	}
}

async function runTurn(threads: ChatThreads, text: string) {
	const thread = await threads.create("故障转移验证");
	const events: RunEvent[] = [];
	await threads.run(thread.id, text, (event) => events.push(event));
	const errors = events
		.filter((e) => e.type === "error")
		.map((e) => (e as { message: string }).message);
	const messages = await threads.messages(thread.id);
	return { thread, errors, reply: messages.at(-1)?.text ?? "" };
}

test("transient 503 on the primary retries, then the turn answers from the fallback", async () => {
	const seenA: Seen[] = [];
	const seenB: Seen[] = [];
	const primary = fakeUpstream(
		[
			() => new Response("busy", { status: 503 }),
			() => new Response("busy", { status: 503 }),
		],
		seenA,
	);
	const fallback = fakeUpstream([() => anthropicText("备用回答")], seenB);
	try {
		await withWorkbench(
			{
				provider: "openai-chat",
				model: "gpt-4o-mini",
				apiKey: "primary-key",
				baseUrl: `http://127.0.0.1:${primary.port}/v1`,
				fallbacks: [
					{
						provider: "anthropic",
						model: "claude-sonnet-4-5",
						apiKey: "fallback-key",
						baseUrl: `http://127.0.0.1:${fallback.port}`,
					},
				],
			},
			async (threads) => {
				const { errors, reply, thread } = await runTurn(threads, "你好");
				expect(errors).toEqual([]);
				expect(reply).toBe("备用回答");
				expect(seenA).toHaveLength(2);
				expect(seenB).toHaveLength(1);
				// The request to the fallback is Anthropic-shaped, not a copy of the OpenAI body.
				expect(seenB[0]!.path).toBe("/v1/messages");
				expect(seenB[0]!.body).toHaveProperty("max_tokens");
				// The thread's recorded provider follows the one that answered.
				const meta = await threads.get(thread.id);
				expect(meta.lastRun?.provider).toBe("anthropic");
			},
		);
	} finally {
		primary.stop(true);
		fallback.stop(true);
	}
});

test("a rejected max_tokens is renamed once, then the same endpoint answers", async () => {
	const seen: Seen[] = [];
	const upstream = fakeUpstream(
		[
			() =>
				new Response(
					JSON.stringify({
						error: {
							message:
								"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
						},
					}),
					{ status: 400, headers: { connection: "close" } },
				),
			() => openaiText("改名后成功"),
			() => openaiText("第二轮直接成功"),
		],
		seen,
	);
	try {
		await withWorkbench(
			{
				provider: "openai-chat",
				model: "gpt-4o-mini",
				apiKey: "k",
				maxTokens: 256,
				baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
			},
			async (threads) => {
				const first = await runTurn(threads, "第一问");
				expect(first.errors).toEqual([]);
				expect(first.reply).toBe("改名后成功");
				expect(seen[0]!.body).toHaveProperty("max_tokens", 256);
				expect(seen[1]!.body).toHaveProperty("max_completion_tokens", 256);
				expect(seen[1]!.body).not.toHaveProperty("max_tokens");
				// Learned for this endpoint: the next turn does not repeat the mistake.
				const second = await runTurn(threads, "第二问");
				expect(second.reply).toBe("第二轮直接成功");
				expect(seen[2]!.body).toHaveProperty("max_completion_tokens", 256);
			},
		);
	} finally {
		upstream.stop(true);
	}
});

test("requests carry a stable per-thread prompt_cache_key", async () => {
	const seen: Seen[] = [];
	const upstream = fakeUpstream(
		[() => openaiText("a"), () => openaiText("b")],
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
				const thread = await threads.create("缓存键");
				await threads.run(thread.id, "一", () => {});
				await threads.run(thread.id, "二", () => {});
				expect(seen[0]!.body.prompt_cache_key).toBe(thread.id);
				expect(seen[1]!.body.prompt_cache_key).toBe(thread.id);
			},
		);
	} finally {
		upstream.stop(true);
	}
});

test("a non-retryable 400 is reported once and the fallback is never called", async () => {
	const seenA: Seen[] = [];
	const seenB: Seen[] = [];
	const primary = fakeUpstream(
		[
			() =>
				new Response('{"error":{"message":"messages: field required"}}', {
					status: 400,
					headers: { connection: "close" },
				}),
		],
		seenA,
	);
	const fallback = fakeUpstream([() => anthropicText("不应到这里")], seenB);
	try {
		await withWorkbench(
			{
				provider: "openai-chat",
				model: "gpt-4o-mini",
				apiKey: "k",
				baseUrl: `http://127.0.0.1:${primary.port}/v1`,
				fallbacks: [
					{
						provider: "anthropic",
						apiKey: "fk",
						baseUrl: `http://127.0.0.1:${fallback.port}`,
					},
				],
			},
			async (threads) => {
				const { errors } = await runTurn(threads, "坏请求");
				expect(errors).toHaveLength(1);
				expect(errors[0]).toContain("HTTP 400");
				expect(seenA).toHaveLength(1);
				expect(seenB).toHaveLength(0);
			},
		);
	} finally {
		primary.stop(true);
		fallback.stop(true);
	}
});

test("a fallback never receives the environment key meant for another vendor", async () => {
	const previous = process.env.WORKBENCH_CHAT_API_KEY;
	process.env.WORKBENCH_CHAT_API_KEY = "vendor-a-env-key";
	const seenA: Seen[] = [];
	const seenB: Seen[] = [];
	const primary = fakeUpstream(
		[
			() => new Response("down", { status: 500 }),
			() => new Response("down", { status: 500 }),
		],
		seenA,
	);
	const fallback = fakeUpstream([() => anthropicText("无密钥不应调用")], seenB);
	try {
		await withWorkbench(
			{
				provider: "openai-chat",
				model: "gpt-4o-mini",
				baseUrl: `http://127.0.0.1:${primary.port}/v1`,
				fallbacks: [
					// No apiKey on a different provider: the env key must not be used.
					{
						provider: "anthropic",
						baseUrl: `http://127.0.0.1:${fallback.port}`,
					},
				],
			},
			async (threads) => {
				const { errors } = await runTurn(threads, "试试");
				expect(seenB).toHaveLength(0);
				expect(errors.join("")).toContain("未配置 API Key");
			},
		);
	} finally {
		primary.stop(true);
		fallback.stop(true);
		if (previous === undefined) delete process.env.WORKBENCH_CHAT_API_KEY;
		else process.env.WORKBENCH_CHAT_API_KEY = previous;
	}
});
