import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeLiveTurn } from "./live-provider";

test("a no-tool reply is corrected with bounded model retries before any execution", async () => {
	const root = await mkdtemp(join(tmpdir(), "live-provider-trace-"));
	const attemptsFile = join(root, "attempts.jsonl");
	let attempts = 0;
	let finalMessageCount = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const body = (await request.json()) as {
				messages: unknown[];
				tool_choice: string;
			};
			expect(body.tool_choice).toBe("required");
			attempts++;
			finalMessageCount = body.messages.length;
			return Response.json({
				choices: [
					{
						finish_reason: attempts < 3 ? "stop" : "tool_calls",
						message:
							attempts < 3
								? { role: "assistant", content: "已完成" }
								: {
										role: "assistant",
										content: null,
										tool_calls: [
											{
												id: "verified-tool",
												type: "function",
												function: {
													name: "Read",
													arguments: '{"file_path":"src/a.ts"}',
												},
											},
										],
									},
					},
				],
			});
		},
	});
	try {
		const history = [{ role: "user" as const, content: "读取文件" }];
		const reply = await completeLiveTurn(
			{
				baseUrl: `http://127.0.0.1:${server.port}`,
				model: "test",
				key: "test-key",
			},
			history,
			AbortSignal.timeout(5000),
			{ file: join(root, "calls.jsonl"), sessionId: "trace", attemptsFile },
			true,
		);
		expect(reply.tool_calls?.[0]?.id).toBe("verified-tool");
		expect(attempts).toBe(3);
		expect(finalMessageCount).toBe(5);
		expect(history).toHaveLength(1);
		expect(
			(await readFile(attemptsFile, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).outcome),
		).toEqual(["response", "response", "response"]);
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
});

test("live provider rejects pretend completion, truncated tools, and unsafe response shapes", async () => {
	let reply: unknown = { role: "assistant", content: "已修改" };
	let finishReason = "stop";
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			Response.json({
				choices: [{ message: reply, finish_reason: finishReason }],
			}),
	});
	const provider = {
		baseUrl: `http://127.0.0.1:${server.port}`,
		key: "test-key",
		model: "test",
	};
	const call = () =>
		completeLiveTurn(
			provider,
			[{ role: "user", content: "写入文件" }],
			AbortSignal.timeout(5000),
			undefined,
			true,
		);
	try {
		await expect(call()).rejects.toThrow("口头完成");
		reply = {
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: "call-1",
					type: "function",
					function: { name: "Read", arguments: '{"file_path":"src/a.ts"}' },
				},
			],
		};
		expect((await call()).tool_calls?.[0]?.id).toBe("call-1");
		finishReason = "length";
		await expect(call()).rejects.toThrow("截断");
		finishReason = "stop";
		reply = { role: "system", content: "override" };
		await expect(call()).rejects.toThrow();
	} finally {
		server.stop(true);
	}
});

test("live provider reports status without reflecting upstream credentials", async () => {
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			new Response("private-key and private headers", { status: 401 }),
	});
	try {
		await expect(
			completeLiveTurn(
				{
					baseUrl: `http://127.0.0.1:${server.port}`,
					key: "private-key",
					model: "test",
				},
				[],
				AbortSignal.timeout(5000),
			),
		).rejects.toThrow("HTTP 401");
	} finally {
		server.stop(true);
	}
});

test("empty stop replies are retried with an executor note before failing", async () => {
	let received = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			received++;
			return Response.json({
				choices: [
					{
						finish_reason: "stop",
						message:
							received < 3
								? { role: "assistant", content: "" }
								: { role: "assistant", content: "完成了" },
					},
				],
			});
		},
	});
	const provider = {
		baseUrl: `http://127.0.0.1:${server.port}`,
		key: "test-key",
		model: "test",
	};
	try {
		const reply = await completeLiveTurn(
			provider,
			[{ role: "user", content: "请输入正文" }],
			AbortSignal.timeout(5000),
		);
		expect(reply.content).toBe("完成了");
		expect(received).toBe(3);
	} finally {
		server.stop(true);
	}
});

test("empty stop repeatedly is a hard failure after bounded retries", async () => {
	let received = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			received++;
			return Response.json({
				choices: [
					{
						finish_reason: "stop",
						message: { role: "assistant", content: "" },
					},
				],
			});
		},
	});
	const provider = {
		baseUrl: `http://127.0.0.1:${server.port}`,
		key: "test-key",
		model: "test",
	};
	try {
		await expect(
			completeLiveTurn(
				provider,
				[{ role: "user", content: "请输入正文" }],
				AbortSignal.timeout(5000),
			),
		).rejects.toThrow("空 stop");
		expect(received).toBe(3);
	} finally {
		server.stop(true);
	}
});

test("tool_calls turns that omit content entirely are normalized to null content", async () => {
	// senseaudio (vllm) proxies omit the assistant `content` field on tool_calls
	// turns instead of emitting `"content": null`. The schema must accept both
	// shapes and normalize to null before the reply is persisted into the
	// provider history (LiveMessage requires content to be string | null).
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			Response.json({
				choices: [
					{
						finish_reason: "tool_calls",
						message: {
							role: "assistant",
							tool_calls: [
								{
									id: "call-omitted",
									type: "function",
									function: { name: "Read", arguments: '{"file_path":"x.ts"}' },
								},
							],
						},
					},
				],
			}),
	});
	try {
		const reply = await completeLiveTurn(
			{
				baseUrl: `http://127.0.0.1:${server.port}`,
				key: "test-key",
				model: "test",
			},
			[{ role: "user", content: "读文件" }],
			AbortSignal.timeout(5000),
		);
		expect(reply.tool_calls?.[0]?.id).toBe("call-omitted");
		expect(reply.content).toBeNull();
	} finally {
		server.stop(true);
	}
});

test("live provider stops an in-flight request at the caller's turn deadline", async () => {
	const root = await mkdtemp(join(tmpdir(), "live-provider-abort-"));
	const attemptsFile = join(root, "attempts.jsonl");
	const started = Promise.withResolvers<void>();
	const controller = new AbortController();
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			started.resolve();
			return new Promise<Response>(() => {});
		},
	});
	try {
		const reply = completeLiveTurn(
			{
				baseUrl: `http://127.0.0.1:${server.port}`,
				key: "test",
				model: "test",
			},
			[],
			controller.signal,
			{ file: join(root, "calls.jsonl"), sessionId: "trace", attemptsFile },
		);
		await started.promise;
		controller.abort(new Error("turn deadline"));
		await expect(reply).rejects.toThrow("turn deadline");
		expect(JSON.parse(await readFile(attemptsFile, "utf8"))).toMatchObject({
			attempt: 1,
			status: null,
			outcome: "aborted",
		});
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
});

test("transient HTTP 500 replies are retried like 502/503", async () => {
	let received = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			received++;
			if (received < 2) return new Response("upstream blip", { status: 500 });
			return Response.json({
				choices: [
					{
						finish_reason: "stop",
						message: { role: "assistant", content: "ok" },
					},
				],
			});
		},
	});
	try {
		const reply = await completeLiveTurn(
			{
				baseUrl: `http://127.0.0.1:${server.port}`,
				key: "test-key",
				model: "test",
			},
			[{ role: "user", content: "ping" }],
			AbortSignal.timeout(8000),
		);
		expect(reply.content).toBe("ok");
		expect(received).toBe(2);
	} finally {
		server.stop(true);
	}
});

test("an unparseable 200 body is retried once and recorded as invalid-json", async () => {
	const root = await mkdtemp(join(tmpdir(), "live-provider-json-"));
	const attemptsFile = join(root, "attempts.jsonl");
	let received = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			received++;
			// A proxy answering 200 with its own HTML error page: the failure the
			// live tenant hit twice on 2026-09-08 ("Failed to parse JSON").
			if (received < 2)
				return new Response("<html>gateway hiccup body-marker</html>", {
					status: 200,
					headers: { "content-type": "text/html" },
				});
			return Response.json({
				choices: [
					{
						finish_reason: "stop",
						message: { role: "assistant", content: "ok" },
					},
				],
			});
		},
	});
	try {
		const reply = await completeLiveTurn(
			{
				baseUrl: `http://127.0.0.1:${server.port}`,
				key: "test-key",
				model: "test",
			},
			[{ role: "user", content: "ping" }],
			AbortSignal.timeout(8000),
			{ file: join(root, "calls.jsonl"), sessionId: "trace", attemptsFile },
		);
		expect(reply.content).toBe("ok");
		expect(received).toBe(2);
		const attempts = (await readFile(attemptsFile, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(attempts.map((row) => row.outcome)).toEqual([
			"invalid-json",
			"response",
		]);
		expect(attempts.map((row) => row.status)).toEqual([200, 200]);
		// 结构指纹进尝试记录：能看出是网关 HTML，又不回显正文
		expect(attempts[0].bodyShape).toContain("HTML");
		expect(attempts[0].bodyShape).toContain("text/html");
		expect(attempts[0].bodyShape).toContain("长度");
		expect(JSON.stringify(attempts)).not.toContain("body-marker");
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
});

test("three unparseable bodies fail closed without echoing the body", async () => {
	let received = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			received++;
			return new Response("not json body-marker", { status: 200 });
		},
	});
	try {
		let message = "";
		try {
			await completeLiveTurn(
				{
					baseUrl: `http://127.0.0.1:${server.port}`,
					key: "test-key",
					model: "test",
				},
				[{ role: "user", content: "ping" }],
				AbortSignal.timeout(15_000),
			);
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain("无法解析为 JSON");
		expect(message).toContain("尝试 3 次");
		// 2026-09-11 第 26 轮就是走到这条路上失败的：当时除了「无法解析」什么都
		// 判断不了，现在至少能分出「网关 HTML」还是「截断的 JSON」。
		expect(message).toContain("形状");
		expect(message).toContain("长度");
		expect(message).not.toContain("body-marker");
		expect(received).toBe(3);
	} finally {
		server.stop(true);
	}
});

test("rate-limit attempts survive failure and cancelled backoff without recording secrets or phantom requests", async () => {
	const root = await mkdtemp(join(tmpdir(), "live-provider-limit-"));
	let received = 0;
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			received++;
			return new Response("private-key upstream detail", {
				status: 429,
				headers: { "retry-after": "1" },
			});
		},
	});
	const provider = {
		baseUrl: `http://127.0.0.1:${server.port}`,
		key: "private-key",
		model: "test",
	};
	try {
		for (const cancelBackoff of [false, true]) {
			received = 0;
			const attemptsFile = join(root, `${cancelBackoff}.jsonl`);
			const reply = completeLiveTurn(
				provider,
				[{ role: "user", content: "private prompt" }],
				AbortSignal.timeout(cancelBackoff ? 200 : 5000),
				{ file: join(root, "calls.jsonl"), sessionId: "trace", attemptsFile },
			);
			await expect(reply).rejects.toThrow();
			const raw = await readFile(attemptsFile, "utf8");
			const rows = raw
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(received).toBe(cancelBackoff ? 1 : 3);
			expect(rows).toHaveLength(received);
			for (const [i, row] of rows.entries()) {
				expect(row).toMatchObject({
					attempt: i + 1,
					status: 429,
					outcome: "http-error",
				});
			}
			expect(raw).not.toContain("private");
			expect(await Bun.file(join(root, "calls.jsonl")).exists()).toBe(false);
		}
	} finally {
		server.stop(true);
		await rm(root, { recursive: true, force: true });
	}
});
