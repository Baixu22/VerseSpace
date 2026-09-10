import { appendFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { liveTools } from "./live-tools";

export interface ToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface LiveMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	tool_calls?: ToolCall[];
	tool_call_id?: string;
}

export interface LiveProvider {
	key: string;
	model: string;
	baseUrl: string;
}

const replySchemaRaw = z.object({
	role: z.literal("assistant"),
	// Some OpenAI-compatible proxies (e.g. senseaudio vllm) omit `content`
	// entirely on tool_calls turns instead of emitting null. Treat missing as null
	// so downstream history persistence stays within LiveMessage shape.
	content: z.string().nullable().optional(),
	tool_calls: z
		.array(
			z.object({
				id: z.string().min(1),
				type: z.literal("function"),
				function: z.object({ name: z.string().min(1), arguments: z.string() }),
			}),
		)
		.max(8)
		.optional(),
});
const replySchema = replySchemaRaw.transform((m) => ({
	...m,
	content: m.content ?? null,
}));

/** Bounded retries only before executing any returned tool calls. */
export async function completeLiveTurn(
	provider: LiveProvider,
	messages: LiveMessage[],
	signal: AbortSignal,
	trace?: { file: string; sessionId: string; attemptsFile?: string },
	requireTools = false,
): Promise<LiveMessage> {
	const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const started = Date.now();
	const requestMessages = [...messages];
	let retryDelay = 0;
	for (let attempt = 0; ; attempt++) {
		if (retryDelay) await setTimeout(retryDelay, undefined, { signal });
		signal.throwIfAborted();
		const attemptStarted = Date.now();
		let status: number | null = null;
		let outcome = "request-error";
		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					authorization: `Bearer ${provider.key}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: provider.model,
					messages: requestMessages,
					tools: liveTools,
					tool_choice: requireTools ? "required" : "auto",
					temperature: 0,
					max_tokens: 4096,
					stream: false,
				}),
				signal,
			});
			status = response.status;
			if (!response.ok) {
				outcome = "http-error";
				await response.body?.cancel();
				if (
					attempt < 2 &&
					[408, 429, 500, 502, 503, 504].includes(response.status)
				) {
					const delay = Math.min(
						10_000,
						Math.max(
							1_000,
							Number(response.headers.get("retry-after") ?? 2) * 1000,
						),
					);
					retryDelay = Number.isFinite(delay) ? delay : 2000;
					continue;
				}
				// Never echo upstream bodies/headers: they may contain credentials.
				throw new Error(
					`真实模型 HTTP ${response.status}（尝试 ${attempt + 1} 次）`,
				);
			}
			outcome = "invalid-response";
			interface CompletionBody {
				id?: string;
				model?: string;
				usage?: {
					prompt_tokens?: number;
					completion_tokens?: number;
					total_tokens?: number;
					cost?: number;
				};
				choices?: Array<{ message?: LiveMessage; finish_reason?: string }>;
			}
			let body: CompletionBody;
			try {
				body = JSON.parse(await response.text()) as CompletionBody;
			} catch {
				// Proxies sometimes answer 200 with an HTML error page or a truncated
				// body (live-tenant 2026-09-08: two S7b rounds died on "Failed to
				// parse JSON"). Nothing has been executed yet, so a bounded retry is
				// as safe as the HTTP 5xx one. The body is never echoed: it may carry
				// anything from gateway markup to reflected headers.
				outcome = "invalid-json";
				if (attempt < 2) {
					retryDelay = 1_000;
					continue;
				}
				throw new Error(
					`真实模型返回了无法解析为 JSON 的正文（尝试 ${attempt + 1} 次）`,
				);
			}
			const choice = body.choices?.[0];
			if (!choice?.message || choice.finish_reason === "length")
				throw new Error("真实模型回复为空或达到 token 上限，未执行截断工具");
			const reply = replySchema.parse(choice.message);
			outcome = "response";
			if (trace)
				await appendFile(
					trace.file,
					`${JSON.stringify({
						at: new Date().toISOString(),
						sessionId: trace.sessionId,
						responseId: body.id,
						model: body.model,
						finishReason: choice.finish_reason,
						elapsedMs: Date.now() - started,
						usage: body.usage && {
							promptTokens: body.usage.prompt_tokens,
							completionTokens: body.usage.completion_tokens,
							totalTokens: body.usage.total_tokens,
							cost: body.usage.cost,
						},
					})}\n`,
				);
			if (requireTools && !reply.tool_calls?.length) {
				if (attempt < 2) {
					retryDelay = 0;
					requestMessages.push(reply, {
						role: "user",
						content:
							"执行器反馈：上一条仅有文本，没有任何工具执行记录，文件没有因此改变。请现在用 function tool_calls 调用 Read/Write 完成当前任务，不能以口头已完成代替工具调用。",
					});
					continue;
				}
				throw new Error("真实模型没有执行必需的工具调用，不接受口头完成");
			}
			// OpenRouter free/proxy models occasionally return finish_reason="stop"
			// with empty content and no tool_calls. Treat it as a transient output
			// contract violation and retry with an executor note the same way we
			// handle "no tool_calls when tools were required".
			if (
				choice.finish_reason === "stop" &&
				!(reply.content ?? "").trim() &&
				!reply.tool_calls?.length
			) {
				outcome = "empty-stop";
				if (attempt < 2) {
					retryDelay = 0;
					requestMessages.push(reply, {
						role: "user",
						content:
							"执行器反馈：上一条回复没有正文也没有工具调用。请重新输出：要么直接回答（一或两句），要么调用 function tool。",
					});
					continue;
				}
				throw new Error("真实模型连续返回空 stop，未提供正文或工具调用");
			}
			return reply;
		} finally {
			if (trace?.attemptsFile)
				await appendFile(
					trace.attemptsFile,
					`${JSON.stringify({
						at: new Date(attemptStarted).toISOString(),
						sessionId: trace.sessionId,
						model: provider.model,
						attempt: attempt + 1,
						status,
						outcome:
							signal.aborted &&
							outcome !== "response" &&
							outcome !== "http-error"
								? "aborted"
								: outcome,
						elapsedMs: Date.now() - attemptStarted,
					})}\n`,
				);
		}
	}
}
