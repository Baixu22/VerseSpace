import type { WorkbenchConfig } from "../types/config";

import { chatApiKey, fallbackApiKey } from "./credentials";
import { buildVariants, clampFanout } from "./fanout";
import { buildHttpRequest, HTTP_PROVIDER_DEFAULTS } from "./http-request";
import { consumeSse, runHttpShadow } from "./http-stream";
import { ModelAdaptation } from "./model-adaptation";
import { promptWithNotices } from "./prompt";
import { type ChatProvider, capabilitiesOf } from "./provider-capabilities";
import type { ThreadContext } from "./thread-context";
import type { MessagePart, TurnRunEvent } from "./thread-types";
import {
	type AttemptOutcome,
	buildAttemptPlan,
	isTransientStreamError,
	type PlannedTarget,
	runWithFailover,
	summariseFailures,
} from "./upstream-policy";

/**
 * Process-wide memory of what each endpoint has rejected. Learned adaptations
 * persist across turns, so a model that refuses `temperature` costs one failed
 * call per process, not one per turn.
 */
const adaptation = new ModelAdaptation();

export async function history(
	context: ThreadContext,
	id: string,
): Promise<Array<{ role: string; content: string }>> {
	const messages = await context.store.messages(id);
	return messages
		.filter((m) => m.text.trim().length > 0)
		.map((m) => ({ role: m.role, content: m.text }));
}

/**
 * Ordered HTTP targets for this turn: the primary first, then the configured
 * fallbacks. Each target carries its own protocol, model, endpoint and key.
 */
export function plannedHttpTargets(
	chat: WorkbenchConfig["chat"],
): PlannedTarget[] {
	const primaryModel =
		chat.model ?? HTTP_PROVIDER_DEFAULTS[chat.provider as "anthropic"]?.model;
	const primary: PlannedTarget = {
		provider: chat.provider as PlannedTarget["provider"],
		model: primaryModel ?? "",
		baseUrl:
			chat.baseUrl ??
			HTTP_PROVIDER_DEFAULTS[chat.provider as "anthropic"]?.baseUrl ??
			"",
		apiKey: chatApiKey(chat),
		label: `${chat.provider}/${primaryModel ?? ""}`,
	};
	const fallbacks = (chat.fallbacks ?? []).map((target): PlannedTarget => {
		const defaults = HTTP_PROVIDER_DEFAULTS[target.provider];
		// A fallback on the same provider inherits the primary endpoint; a
		// different provider never does (its base URL belongs to another vendor).
		const sameProvider = target.provider === chat.provider;
		const baseUrl =
			target.baseUrl ??
			(sameProvider ? chat.baseUrl : undefined) ??
			defaults.baseUrl;
		const model = target.model ?? defaults.model;
		return {
			provider: target.provider,
			model,
			baseUrl,
			apiKey: fallbackApiKey(chat, target),
			label: `${target.provider}/${model}`,
		};
	});
	return buildAttemptPlan([primary, ...fallbacks]);
}

/** The chat config a single target would have had if it were the primary. */
function effectiveChat(
	chat: WorkbenchConfig["chat"],
	target: PlannedTarget,
): WorkbenchConfig["chat"] {
	return {
		...chat,
		provider: target.provider,
		model: target.model,
		baseUrl: target.baseUrl,
		apiKey: target.apiKey,
	};
}

export interface HttpRunResult {
	/** The provider that actually answered; may differ from the configured primary. */
	provider: ChatProvider;
	model: string;
}

export async function runHttp(
	context: ThreadContext,
	chat: WorkbenchConfig["chat"],
	id: string,
	emit: (event: TurnRunEvent) => void,
	messageParts: MessagePart[],
	signal: AbortSignal,
	precedingNotices: string[],
	onContextObserved?: () => Promise<void>,
	onNoticesSent?: () => Promise<boolean>,
): Promise<HttpRunResult | undefined> {
	const targets = plannedHttpTargets(chat);
	const primary = targets[0]!;
	if (
		targets.length === 1 &&
		capabilitiesOf(primary.provider).requiresApiKey &&
		!primary.apiKey
	) {
		emit({
			type: "error",
			message: "未配置 API Key——在 设置 中填写后重试",
		});
		return undefined;
	}

	const priorMessages = await history(context, id);
	const noticesIncluded =
		precedingNotices.length === 0 || priorMessages.length > 0;
	if (precedingNotices.length > 0 && noticesIncluded) {
		const last = priorMessages.at(-1)!;
		last.content = promptWithNotices(last.content, precedingNotices);
	}
	const fanout = clampFanout(chat.fanout);
	const maxAttempts = chat.maxAttempts ?? 2;

	const result = await runWithFailover<{
		shadowTexts: string[];
		primaryText: string;
	}>({
		targets,
		maxAttempts,
		adaptation,
		signal,
		buildBody: (target) => {
			const { body } = buildHttpRequest(
				target.provider,
				target.apiKey,
				effectiveChat(chat, target),
				priorMessages,
				id,
			);
			return body;
		},
		send: (target, body) =>
			sendOne({
				target,
				body,
				chat,
				fanout,
				emit,
				messageParts,
				signal,
				precedingNotices,
				noticesIncluded,
				onContextObserved,
				onNoticesSent,
			}),
	});

	if (!result.ok || !result.target) {
		// Failures before any output: the transcript is still clean, so one
		// summary replaces the per-attempt noise.
		if (result.failures.length === 0) {
			emit({ type: "error", message: "没有可用的模型目标" });
		} else {
			emit({ type: "error", message: summariseFailures(result.failures) });
		}
		return undefined;
	}

	if (result.target !== primary) {
		console.warn(
			`[chat] 主目标不可用，本轮已切换到备用目标 ${result.target.label}`,
		);
	}
	// The per-attempt value carries the shadow variants; they are attached here
	// so only the successful attempt's alternates are shown.
	context.pendingVariants.set(
		id,
		buildVariants(result.value!.primaryText, result.value!.shadowTexts, fanout),
	);
	return {
		provider: result.target.provider,
		model: result.target.model,
	};
}

interface SendOneInput {
	target: PlannedTarget;
	body: Record<string, unknown>;
	chat: WorkbenchConfig["chat"];
	fanout: number;
	emit: (event: TurnRunEvent) => void;
	messageParts: MessagePart[];
	signal: AbortSignal;
	precedingNotices: string[];
	noticesIncluded: boolean;
	onContextObserved?: () => Promise<void>;
	onNoticesSent?: () => Promise<boolean>;
}

/**
 * One request to one target. It never emits a terminal error itself: failures
 * are returned to the orchestrator, which decides whether to retry, adapt,
 * switch, or surface them. Text deltas are emitted as they arrive, which is
 * what makes `emittedOutput` a reliable "too late to switch" marker.
 */
async function sendOne({
	target,
	body,
	chat,
	fanout,
	emit,
	messageParts,
	signal,
	precedingNotices,
	noticesIncluded,
	onContextObserved,
	onNoticesSent,
}: SendOneInput): Promise<
	AttemptOutcome & { value?: { shadowTexts: string[]; primaryText: string } }
> {
	const provider = target.provider;
	// Endpoint and auth headers only: the body is built once per attempt by
	// the orchestrator (with history and the thread cache key) and arrives here
	// already adapted, so the empty history below is never sent.
	const { url, headers } = buildHttpRequest(
		provider,
		target.apiKey,
		effectiveChat(chat, target),
		[],
	);
	// Per-attempt controller: a failed attempt must cancel its shadows without
	// cancelling the user's turn, while a user cancel still reaches everything.
	const attempt = new AbortController();
	const onAbort = () => attempt.abort();
	signal.addEventListener("abort", onAbort, { once: true });

	let emittedOutput = false;
	let streamErrored = false;
	let streamErrorMessage = "";
	let streamMalformed = false;
	let streamTerminal = false;
	const onSseData = (payload: string) => {
		if (!payload) return;
		if (payload === "[DONE]") {
			streamTerminal = true;
			return;
		}
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(payload) as Record<string, unknown>;
		} catch {
			streamMalformed = true;
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
				streamErrorMessage = err?.message ?? "anthropic stream error";
			}
		} else if (provider === "openai-chat") {
			if (event.type === "error" || event.error) {
				streamErrored = true;
				const err = event.error as { message?: string } | undefined;
				streamErrorMessage =
					err?.message ?? String(event.message ?? "openai stream error");
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
				streamErrorMessage = String(event.message ?? "responses error");
			}
		}
		if (delta) {
			emittedOutput = true;
			const last = messageParts.at(-1);
			if (last?.type === "text") {
				last.text += delta;
			} else {
				messageParts.push({ type: "text", text: delta });
			}
			emit({ type: "delta", text: delta });
		}
	};

	try {
		// The main request goes first: it is the streamed answer. Shadow
		// variants follow concurrently and are captured, never displayed.
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: attempt.signal,
		});
		if (!response.ok || !response.body) {
			const detail = (await response.text().catch(() => "")).slice(0, 300);
			return {
				ok: false,
				status: response.status,
				message: `${provider} HTTP ${response.status}：${detail}`,
				emittedOutput: false,
				retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
			};
		}

		const shadowPromises =
			fanout > 1
				? Array.from({ length: fanout - 1 }, () =>
						runHttpShadow(provider, url, headers, body, attempt.signal),
					)
				: [];

		const stream = await consumeSse(response, onSseData);
		const streamFailed =
			streamErrored || streamMalformed || !stream.complete || !streamTerminal;
		if (streamFailed) {
			// Abandon this attempt's shadows; they are not part of any answer.
			attempt.abort();
			await Promise.all(shadowPromises);
			const message = streamErrored
				? streamErrorMessage || `${provider} stream error`
				: streamMalformed
					? "provider 返回了损坏的 SSE 数据"
					: stream.complete
						? "provider 流没有结束标记，通知保留待重试"
						: "provider SSE 流在完整帧前结束，通知保留待重试";
			return {
				ok: false,
				message,
				emittedOutput,
				// A cut-off stream or a recognised transient error may succeed on
				// retry. A malformed frame or a bad-request error will not.
				transient: streamErrored
					? isTransientStreamError(streamErrorMessage)
					: !streamMalformed,
			};
		}

		// Only a completely consumed, non-error stream proves the provider
		// accepted the combined turn; notices are acknowledged only here.
		try {
			await onContextObserved?.();
		} catch {
			// Observability is additive; it must not fail a successful turn.
		}
		if (precedingNotices.length > 0 && noticesIncluded) {
			try {
				await onNoticesSent?.();
			} catch {
				// A failed acknowledgement leaves the durable queue for retry.
			}
		}

		const shadowTexts = await Promise.all(shadowPromises);
		const primaryText = messageParts
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text)
			.join("");
		return {
			ok: true,
			emittedOutput,
			value: { shadowTexts, primaryText },
		};
	} catch (error) {
		if (signal.aborted) throw error;
		return {
			ok: false,
			message: error instanceof Error ? error.message : String(error),
			emittedOutput,
		};
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(value);
	if (Number.isFinite(date)) return Math.max(0, date - Date.now());
	return undefined;
}
