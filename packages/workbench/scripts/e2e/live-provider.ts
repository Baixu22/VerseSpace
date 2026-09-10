import { appendFile } from "node:fs/promises";
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

/**
 * 重试之间的退避等待，**不用** `node:timers/promises` 的 `{ signal }` 版本。
 *
 * TF-0158 的 stuck point 就在这里：同一进程里先前有过一次 in-flight 中止之后，
 * `await setTimeout(delay, undefined, { signal })` 会永远不结算。`bun test` 里的
 * 表现是第 7 条（in-flight 中止）跑完、第 8 条的 500 退避停在这一行不再返回，
 * 而且连测试框架自己的 `--timeout` 都不响。裸定时器 + 显式监听 abort 语义等价
 * （abort 时同样以 signal 的原因拒绝），但不依赖那条会卡住的接线。
 */
function backoff(delay: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			globalThis.clearTimeout(timer);
			reject(signal.reason ?? new Error("aborted"));
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		const timer = globalThis.setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delay);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 无法解析的响应正文：只描述**结构**，不回显内容。
 *
 * 为什么需要它：2026-09-11 的第 26 轮真实采样重试用尽后失败，而错误信息除了
 * 「无法解析为 JSON」什么都给不出——网关的 HTML 错误页与被截断的 JSON 是两种
 * 完全不同的处置（前者要退避/换端点，后者要抬高 max_tokens 或换非流式）。
 * 正文本身仍然绝不进错误信息与日志（可能带网关标记或反射头），所以只留长度、
 * 首字符类别、是否闭合与 content-type 这四样结构事实。
 */
function bodyShape(text: string, response: Response): string {
	const trimmed = text.trim();
	const head =
		trimmed.length === 0
			? "空正文"
			: trimmed.startsWith("<")
				? "HTML"
				: trimmed.startsWith("{")
					? "JSON 开头"
					: trimmed.startsWith("[")
						? "数组开头"
						: "其他";
	const closed =
		trimmed.endsWith("}") || trimmed.endsWith("]") ? "已闭合" : "未闭合";
	const type = response.headers.get("content-type") ?? "无 content-type";
	return `长度 ${text.length} · 形状 ${head} · ${closed} · ${type}`;
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
		if (retryDelay) await backoff(retryDelay, signal);
		signal.throwIfAborted();
		const attemptStarted = Date.now();
		let status: number | null = null;
		let outcome = "request-error";
		/** 只在 invalid-json 时填：正文的结构指纹（绝不回显正文）。 */
		let shape: string | undefined;
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
			const raw = await response.text();
			try {
				body = JSON.parse(raw) as CompletionBody;
			} catch {
				// Proxies sometimes answer 200 with an HTML error page or a truncated
				// body (live-tenant 2026-09-08: two S7b rounds died on "Failed to
				// parse JSON"). Nothing has been executed yet, so a bounded retry is
				// as safe as the HTTP 5xx one. The body is never echoed: it may carry
				// anything from gateway markup to reflected headers.
				outcome = "invalid-json";
				// 正文之外的**结构指纹**要留下：2026-09-11 真出现了一次重试用尽
				// （第 26 轮），而当时除了「无法解析」之外什么都判断不了——是网关
				// HTML、还是被截断的 JSON，处置完全不同。指纹只报长度/形状/结尾是
				// 否闭合与 content-type，不回显任何正文内容。
				shape = bodyShape(raw, response);
				if (attempt < 2) {
					retryDelay = 1_000;
					continue;
				}
				throw new Error(
					`真实模型返回了无法解析为 JSON 的正文（尝试 ${attempt + 1} 次）：${shape}`,
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
						// 结构指纹进尝试记录：这样「重试用尽」之外，那 9 次被重试
						// 兜住的 invalid-json 也能被事后归类（HTML 页 / 截断流）。
						...(shape ? { bodyShape: shape } : {}),
						elapsedMs: Date.now() - attemptStarted,
					})}\n`,
				);
		}
	}
}
