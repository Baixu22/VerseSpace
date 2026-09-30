import { expect, test } from "bun:test";
import { completeLiveTurn } from "./live-provider";
import { liveCompletion, liveProtocol, liveRequest } from "./live-wire";

test("Responses tool IDs and reasoning survive a complete call/result round trip", async () => {
	let requestCount = 0;
	const output = [
		{ type: "reasoning", id: "reason", summary: [] },
		{
			type: "function_call",
			id: "item-1",
			call_id: "call-1",
			name: "Read",
			arguments: '{"file_path":"src/a.ts"}',
			status: "completed",
		},
	];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			expect(new URL(request.url).pathname).toBe("/v1/responses");
			const body = (await request.json()) as {
				input: unknown[];
				tools: Array<{ name: string }>;
				store: boolean;
			};
			expect(body.tools[0]?.name).toBe("Read");
			expect(body.store).toBe(false);
			requestCount++;
			if (requestCount === 2) {
				expect(body.input).toContainEqual(output[0]);
				expect(body.input).toContainEqual(output[1]);
				expect(body.input.at(-1)).toEqual({
					type: "function_call_output",
					call_id: "call-1",
					output: "file contents",
				});
			}
			return Response.json({
				id: "response-1",
				status: "completed",
				output:
					requestCount === 1
						? output
						: [
								{
									type: "message",
									role: "assistant",
									content: [{ type: "output_text", text: "done" }],
								},
							],
			});
		},
	});
	try {
		const provider = {
			key: "test-key",
			model: "test",
			baseUrl: `http://127.0.0.1:${server.port}/v1/responses`,
		};
		const history = [{ role: "user" as const, content: "read a file" }];
		const first = await completeLiveTurn(
			provider,
			history,
			AbortSignal.timeout(5000),
			undefined,
			true,
		);
		expect(first.tool_calls?.[0]?.id).toBe("call-1");
		const second = await completeLiveTurn(
			provider,
			[
				...history,
				first,
				{ role: "tool", tool_call_id: "call-1", content: "file contents" },
			],
			AbortSignal.timeout(5000),
		);
		expect(second.content).toBe("done");
	} finally {
		server.stop(true);
	}
});

test("incomplete or malformed Responses tool output cannot execute", () => {
	for (const status of ["incomplete", "failed", "in_progress"])
		expect(() =>
			liveCompletion({ status, output: [] }, "openai-responses"),
		).toThrow();
	expect(() =>
		liveCompletion(
			{
				status: "completed",
				output: [
					{
						type: "function_call",
						call_id: "x",
						name: "Read",
						arguments: "{}",
						status: "incomplete",
					},
				],
			},
			"openai-responses",
		),
	).toThrow();
	expect(() =>
		liveCompletion(
			{
				status: "completed",
				output: [
					{
						type: "function_call",
						id: "missing-call-id",
						name: "Read",
						arguments: "{}",
					},
				],
			},
			"openai-responses",
		),
	).toThrow();
});

test("bases and complete endpoints use the existing URL contract without double append", () => {
	expect(liveProtocol(' "https://example.test/v1/responses/" ')).toBe(
		"openai-responses",
	);
	expect(
		liveRequest(
			{
				baseUrl: "https://example.test/v1/chat/completions",
				key: "test",
				model: "test",
			},
			[],
			false,
		).url,
	).toBe("https://example.test/v1/chat/completions");
	expect(() =>
		liveRequest(
			{
				baseUrl: "https://user:secret@example.test/v1",
				key: "test",
				model: "test",
			},
			[],
			false,
		),
	).toThrow();
});
