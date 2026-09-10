import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { makeTempWorkbench } from "../test/fixtures";
import { workbenchConfigSchema } from "../types/config";
import { collectState, createUiServer } from "../ui/server";
import { chatApiKey, publicChatConfig } from "./credentials";
import { ChatThreads } from "./threads";

test("environment key is used for HTTP, masked on every UI surface, and never saved", async () => {
	const previous = process.env.WORKBENCH_CHAT_API_KEY;
	process.env.WORKBENCH_CHAT_API_KEY = "private-environment-key";
	const ws = await makeTempWorkbench();
	let authorization = "";
	let requestedPath = "";
	const provider = Bun.serve({
		port: 0,
		fetch(request) {
			authorization = request.headers.get("authorization") ?? "";
			requestedPath = new URL(request.url).pathname;
			return new Response(
				'data: {"choices":[{"delta":{"content":"真实通道"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const ui = await createUiServer(ws.bb, 0);
	try {
		const config = workbenchConfigSchema.parse({
			chat: {
				provider: "openai-chat",
				baseUrl: `“http://127.0.0.1:${provider.port}/chat/completions”`,
			},
		});
		await ws.bb.config.save(config);
		expect(chatApiKey(config.chat)).toBe("private-environment-key");
		expect(chatApiKey({ ...config.chat, apiKey: "saved-key" })).toBe(
			"saved-key",
		);
		expect(publicChatConfig(config.chat)).toMatchObject({ hasKey: true });
		const chat = new ChatThreads(ws.bb);
		const thread = await chat.create("环境凭据验证");
		await chat.run(thread.id, "检查连接", () => {});
		expect(authorization).toBe("Bearer private-environment-key");
		expect(requestedPath).toBe("/chat/completions");
		expect((await chat.messages(thread.id)).at(-1)?.text).toBe("真实通道");
		const base = `http://127.0.0.1:${ui.port}`;
		const { token } = (await (await fetch(`${base}/api/bootstrap`)).json()) as {
			token: string;
		};
		for (const method of ["GET", "PATCH"]) {
			const response = await fetch(`${base}/api/config/chat`, {
				method,
				headers: {
					"x-workbench-token": token,
					"content-type": "application/json",
				},
				...(method === "PATCH"
					? { body: JSON.stringify({ maxTokens: 512 }) }
					: {}),
			});
			const body = await response.text();
			expect(response.ok).toBe(true);
			expect(JSON.parse(body).hasKey).toBe(true);
			expect(body).not.toContain("private-environment-key");
			expect(body).not.toContain("apiKey");
		}
		expect(await readFile(ws.bb.paths.config, "utf8")).not.toContain(
			"private-environment-key",
		);
		await ws.bb.config.save({
			...config,
			chat: { ...config.chat, apiKey: "saved-key" },
		});
		const state = JSON.stringify(await collectState(ws.bb));
		expect(state).not.toContain("saved-key");
		expect(state).not.toContain("private-environment-key");
	} finally {
		ui.stop(true);
		provider.stop(true);
		if (previous === undefined) delete process.env.WORKBENCH_CHAT_API_KEY;
		else process.env.WORKBENCH_CHAT_API_KEY = previous;
		await ws.cleanup();
	}
});
