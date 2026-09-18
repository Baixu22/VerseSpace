import type { WorkbenchConfig } from "../types/config";

import { chatApiKey } from "./credentials";
import { buildVariants, clampFanout } from "./fanout";
import { buildHttpRequest } from "./http-request";
import { consumeSse, runHttpShadow } from "./http-stream";
import { promptWithNotices } from "./prompt";
import { capabilitiesOf } from "./provider-capabilities";
import type { ThreadContext } from "./thread-context";
import type { MessagePart, RunEvent } from "./thread-types";

export async function history(
	context: ThreadContext,
	id: string,
): Promise<Array<{ role: string; content: string }>> {
	const messages = await context.store.messages(id);
	return messages
		.filter((m) => m.text.trim().length > 0)
		.map((m) => ({ role: m.role, content: m.text }));
}

export async function runHttp(
	context: ThreadContext,
	chat: WorkbenchConfig["chat"],
	id: string,
	emit: (event: RunEvent) => void,
	messageParts: MessagePart[],
	signal: AbortSignal,
	precedingNotices: string[],
	onContextObserved?: () => Promise<void>,
	onNoticesSent?: () => Promise<boolean>,
): Promise<void> {
	const provider = chat.provider;
	const key = chatApiKey(chat);
	if (capabilitiesOf(provider).requiresApiKey && !key) {
		emit({
			type: "error",
			message: "未配置 API Key——在 设置 中填写后重试",
		});
		return;
	}

	const priorMessages = await history(context, id);
	const noticesIncluded =
		precedingNotices.length === 0 || priorMessages.length > 0;
	if (precedingNotices.length > 0 && noticesIncluded) {
		const last = priorMessages.at(-1)!;
		last.content = promptWithNotices(last.content, precedingNotices);
	}
	const fanout = clampFanout(chat.fanout);
	const { url, headers, body } = buildHttpRequest(
		provider,
		key,
		chat,
		priorMessages,
	);

	let streamErrored = false;
	let streamMalformed = false;
	let streamTerminal = false;
	let malformedReported = false;
	const onSseData = (payload: string) => {
		if (!payload) {
			return;
		}
		if (payload === "[DONE]") {
			streamTerminal = true;
			return;
		}
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(payload) as Record<string, unknown>;
		} catch {
			streamMalformed = true;
			if (!malformedReported) {
				malformedReported = true;
				emit({ type: "error", message: "provider 返回了损坏的 SSE 数据" });
			}
			return;
		}
		let delta: string | undefined;
		if (provider === "anthropic") {
			if (event.type === "content_block_delta") {
				const d = event.delta as { type?: string; text?: string } | undefined;
				if (d?.type === "text_delta" && d.text) {
					delta = d.text;
				}
			} else if (event.type === "message_stop") {
				streamTerminal = true;
			} else if (event.type === "error") {
				streamErrored = true;
				const err = event.error as { message?: string } | undefined;
				emit({
					type: "error",
					message: err?.message ?? "anthropic stream error",
				});
			}
		} else if (provider === "openai-chat") {
			if (event.type === "error" || event.error) {
				streamErrored = true;
				const err = event.error as { message?: string } | undefined;
				emit({
					type: "error",
					message:
						err?.message ?? String(event.message ?? "openai stream error"),
				});
			}
			const choices = event.choices as
				| Array<{
						delta?: { content?: string };
						finish_reason?: string | null;
				  }>
				| undefined;
			delta = choices?.[0]?.delta?.content;
			if (choices?.[0]?.finish_reason) {
				streamTerminal = true;
			}
		} else {
			// openai-responses
			if (event.type === "response.output_text.delta") {
				delta = event.delta as string;
			} else if (
				event.type === "response.completed" ||
				event.type === "response.done"
			) {
				streamTerminal = true;
			} else if (
				event.type === "error" ||
				event.type === "response.failed" ||
				event.type === "response.incomplete"
			) {
				streamErrored = true;
				emit({
					type: "error",
					message: String(event.message ?? "responses error"),
				});
			}
		}
		if (delta) {
			const last = messageParts.at(-1);
			if (last?.type === "text") {
				last.text += delta;
			} else {
				messageParts.push({ type: "text", text: delta });
			}
			emit({ type: "delta", text: delta });
		}
	};

	// 主请求先发出（它是流式展示的主角），shadow 变体随后并发、只捕获
	// 不展示。shadow 的任何失败都被吞掉（runHttpShadow 返回空串）——
	// 备选是余光，绝不打扰主回答；cancel 经由同一个 signal 中止全部。
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	});
	if (!response.ok || !response.body) {
		const detail = (await response.text()).slice(0, 300);
		emit({
			type: "error",
			message: `${provider} HTTP ${response.status}：${detail}`,
		});
		return;
	}
	const shadowPromises =
		fanout > 1
			? Array.from({ length: fanout - 1 }, () =>
					runHttpShadow(provider, url, headers, body, signal),
				)
			: [];

	const stream = await consumeSse(response, onSseData);
	// Only a completely consumed, non-error stream proves that the provider
	// accepted the combined turn. Header-level 2xx is not enough: a truncated
	// body must leave the notice for the next attempt.
	if (!stream.complete || !streamTerminal) {
		if (!streamErrored) {
			emit({
				type: "error",
				message: stream.complete
					? "provider 流没有结束标记，通知保留待重试"
					: "provider SSE 流在完整帧前结束，通知保留待重试",
			});
		}
	} else if (!streamErrored && !streamMalformed) {
		try {
			await onContextObserved?.();
		} catch {
			// Observability is additive; it must not turn a successful provider
			// response into a failed chat turn.
		}
		if (precedingNotices.length > 0 && noticesIncluded) {
			try {
				await onNoticesSent?.();
			} catch {
				// A failed acknowledgement leaves the durable queue for retry.
			}
		}
	}
	// 主回答结束：收下 shadow 文本，备选挂在 run() 的 finally 里组装
	const shadowTexts = await Promise.all(shadowPromises);
	const primaryText = messageParts
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text)
		.join("");
	context.pendingVariants.set(
		id,
		buildVariants(primaryText, shadowTexts, fanout),
	);
}
