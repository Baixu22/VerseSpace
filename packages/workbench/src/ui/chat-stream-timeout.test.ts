import { expect, test } from "bun:test";
import { ChatThreads } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import { createUiServer } from "./server";

test("a silent model turn outlives HTTP idle timeout and still delivers its terminal event", async () => {
	const ws = await makeTempWorkbench();
	const upstream = Bun.serve({
		port: 0,
		idleTimeout: 0,
		fetch: () =>
			new Response(
				new ReadableStream({
					async start(controller) {
						await new Promise((resolve) => setTimeout(resolve, 6200));
						controller.enqueue(
							new TextEncoder().encode(
								'data: {"type":"response.output_text.delta","delta":"ready"}\n\ndata: {"type":"response.completed"}\n\n',
							),
						);
						controller.close();
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			),
	});
	await ws.bb.config.save({
		chat: {
			provider: "openai-responses",
			apiKey: "test",
			baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
		},
	});
	const chat = new ChatThreads(ws.bb);
	const thread = await chat.create();
	const server = await createUiServer(ws.bb, 0, undefined, {
		idleTimeoutSeconds: 1,
	});
	try {
		const response = await fetch(
			`http://127.0.0.1:${server.port}/api/chat/threads/${thread.id}/messages`,
			{
				method: "POST",
				headers: {
					"x-workbench-token": server.authToken,
					"content-type": "application/json",
				},
				body: JSON.stringify({ text: "hello" }),
				signal: AbortSignal.timeout(12000),
			},
		);
		const events = (await response.text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(events.find((event) => event.type === "done")?.message.text).toBe(
			"ready",
		);
	} finally {
		server.stop(true);
		upstream.stop(true);
		await ws.cleanup();
	}
}, 15_000);
