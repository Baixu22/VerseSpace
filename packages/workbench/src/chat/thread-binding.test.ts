import { describe, expect, test } from "bun:test";
import { makeTempWorkbench } from "../test/fixtures";
import { workbenchConfigSchema } from "../types/config";
import {
	decideBinding,
	endpointFingerprint,
	type ThreadBinding,
} from "./thread-binding";
import type { RunEvent } from "./thread-types";
import { ChatThreads } from "./threads";

const chatOf = (overrides: Record<string, unknown>) =>
	workbenchConfigSchema.parse({
		chat: { provider: "openai-chat", model: "gpt-4o-mini", ...overrides },
	}).chat;

const binding = (overrides: Partial<ThreadBinding> = {}): ThreadBinding => ({
	provider: "openai-chat",
	model: "gpt-4o-mini",
	endpoint: endpointFingerprint("openai-chat", undefined),
	boundAt: "2026-10-12T00:00:00.000Z",
	...overrides,
});

describe("binding decision", () => {
	test("an unbound or empty thread adopts the current configuration", () => {
		expect(decideBinding(undefined, true, chatOf({})).kind).toBe("bind");
		expect(decideBinding(binding(), false, chatOf({})).kind).toBe("bind");
	});

	test("same provider, model and endpoint continues in place", () => {
		expect(decideBinding(binding(), true, chatOf({})).kind).toBe("same");
	});

	test("a protocol change forks; the source is never rebound in place", () => {
		const decision = decideBinding(
			binding(),
			true,
			chatOf({ provider: "anthropic", model: "claude-sonnet-4-5" }),
		);
		expect(decision.kind).toBe("fork");
	});

	test("a model change on the same protocol rebinds without forking", () => {
		const decision = decideBinding(
			binding(),
			true,
			chatOf({ model: "gpt-4.1" }),
		);
		expect(decision).toMatchObject({ kind: "rebind", reason: "model" });
	});

	test("an endpoint change on the same protocol rebinds, with the URL hashed", () => {
		const decision = decideBinding(
			binding(),
			true,
			chatOf({ baseUrl: "https://gateway.example.com/v1" }),
		);
		expect(decision).toMatchObject({ kind: "rebind", reason: "endpoint" });
		expect(decision.next.endpoint).not.toContain("gateway");
	});

	test("the endpoint fingerprint ignores trailing slashes and case", () => {
		expect(
			endpointFingerprint("openai-chat", "https://X.example.com/v1/"),
		).toBe(endpointFingerprint("openai-chat", "https://x.example.com/v1"));
	});
});

async function runTurn(threads: ChatThreads, id: string, text: string) {
	const events: RunEvent[] = [];
	await threads.run(id, text, (event) => events.push(event));
	return events;
}

describe("protocol switch on a live thread", () => {
	test("switching protocol forks the turn; the source keeps its transcript", async () => {
		const ws = await makeTempWorkbench();
		const openaiServer = Bun.serve({
			port: 0,
			async fetch() {
				return new Response(
					`data: ${JSON.stringify({ choices: [{ delta: { content: "甲" } }] })}\n\n` +
						`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
						"data: [DONE]\n\n",
					{
						headers: {
							"content-type": "text/event-stream",
							connection: "close",
						},
					},
				);
			},
		});
		const anthropicServer = Bun.serve({
			port: 0,
			async fetch() {
				return new Response(
					`data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "乙" } })}\n\n` +
						`data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
					{
						headers: {
							"content-type": "text/event-stream",
							connection: "close",
						},
					},
				);
			},
		});
		try {
			const openaiBase = `http://127.0.0.1:${openaiServer.port}/v1`;
			await ws.bb.config.save(
				workbenchConfigSchema.parse({
					chat: {
						provider: "openai-chat",
						model: "gpt-4o-mini",
						apiKey: "k",
						baseUrl: openaiBase,
					},
				}),
			);
			const threads = new ChatThreads(ws.bb);
			const thread = await threads.create("协议切换");
			await runTurn(threads, thread.id, "第一句");
			expect((await threads.get(thread.id)).binding?.provider).toBe(
				"openai-chat",
			);

			await ws.bb.config.save(
				workbenchConfigSchema.parse({
					chat: {
						provider: "anthropic",
						model: "claude-sonnet-4-5",
						apiKey: "k",
						baseUrl: `http://127.0.0.1:${anthropicServer.port}`,
					},
				}),
			);
			const events = await runTurn(threads, thread.id, "第二句");
			const forked = events.find((e) => e.type === "forked");
			expect(forked).toBeDefined();
			const forkId = (forked as { threadId: string }).threadId;
			expect(forkId).not.toBe(thread.id);

			// The source is untouched: still two messages, still bound to OpenAI.
			const source = await threads.messages(thread.id);
			expect(source.map((m) => m.text)).toEqual(["第一句", "甲"]);
			expect((await threads.get(thread.id)).binding?.provider).toBe(
				"openai-chat",
			);

			// The fork inherited the first exchange and answered the second on Anthropic.
			const fork = await threads.messages(forkId);
			expect(fork.map((m) => m.text)).toEqual(["第一句", "甲", "第二句", "乙"]);
			const forkMeta = await threads.get(forkId);
			expect(forkMeta.binding?.provider).toBe("anthropic");
			expect(forkMeta.lastRun?.provider).toBe("anthropic");
		} finally {
			openaiServer.stop(true);
			anthropicServer.stop(true);
			await ws.cleanup();
		}
	});

	test("a model change keeps the thread and records the new binding", async () => {
		const ws = await makeTempWorkbench();
		const server = Bun.serve({
			port: 0,
			async fetch() {
				return new Response(
					`data: ${JSON.stringify({ choices: [{ delta: { content: "好" } }] })}\n\n` +
						`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n` +
						"data: [DONE]\n\n",
					{
						headers: {
							"content-type": "text/event-stream",
							connection: "close",
						},
					},
				);
			},
		});
		try {
			const base = `http://127.0.0.1:${server.port}/v1`;
			await ws.bb.config.save(
				workbenchConfigSchema.parse({
					chat: {
						provider: "openai-chat",
						model: "gpt-4o-mini",
						apiKey: "k",
						baseUrl: base,
					},
				}),
			);
			const threads = new ChatThreads(ws.bb);
			const thread = await threads.create("换模型");
			await runTurn(threads, thread.id, "一");
			await ws.bb.config.save(
				workbenchConfigSchema.parse({
					chat: {
						provider: "openai-chat",
						model: "gpt-4.1",
						apiKey: "k",
						baseUrl: base,
					},
				}),
			);
			const events = await runTurn(threads, thread.id, "二");
			expect(events.some((e) => e.type === "forked")).toBe(false);
			expect((await threads.messages(thread.id)).length).toBe(4);
			expect((await threads.get(thread.id)).binding?.model).toBe("gpt-4.1");
		} finally {
			server.stop(true);
			await ws.cleanup();
		}
	});
});
