import type { WorkbenchConfig } from "../types/config";

import { chatApiKey, fallbackApiKey } from "./credentials";
import { buildVariants, clampFanout } from "./fanout";
import { buildHttpRequest, HTTP_PROVIDER_DEFAULTS } from "./http-request";
import { consumeSse, runHttpShadow } from "./http-stream";
import { ModelAdaptation } from "./model-adaptation";
import { promptWithNotices } from "./prompt";
import {
	classifyFailure,
	codecFor,
	finalizeUsage,
	type HttpProvider,
	isHttpProvider,
	mergeUsage,
	type StreamError,
	type TurnUsage,
	type UsagePatch,
} from "./protocols";
import { type ChatProvider, capabilitiesOf } from "./provider-capabilities";
import type { ThreadContext } from "./thread-context";
import type { MessagePart, TurnRunEvent } from "./thread-types";
import {
	type AttemptOutcome,
	buildAttemptPlan,
	type PlannedTarget,
	runWithFailover,
	summariseFailures,
	TargetHealth,
} from "./upstream-policy";

/**
 * Process-wide memory of what each endpoint has rejected. Learned adaptations
 * persist across turns, so a model that refuses `temperature` costs one failed
 * call per process, not one per turn.
 */
const adaptation = new ModelAdaptation();

/**
 * Process-wide cooldown per target. A target that keeps failing is tried last
 * for a minute, so a dead primary stops adding latency to every turn.
 */
const health = new TargetHealth();

/** Idle budget between bytes from the upstream, and before the first byte. */
const DEFAULT_TIMEOUT_MS = 90_000;

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
	const provider = chat.provider as HttpProvider;
	const primaryModel = chat.model ?? HTTP_PROVIDER_DEFAULTS[provider]?.model;
	const primary: PlannedTarget = {
		provider,
		model: primaryModel ?? "",
		baseUrl: chat.baseUrl ?? HTTP_PROVIDER_DEFAULTS[provider]?.baseUrl ?? "",
		apiKey: chatApiKey(chat),
		label: `${provider}/${primaryModel ?? ""}`,
	};
	const fallbacks = (chat.fallbacks ?? []).map((target): PlannedTarget => {
		const defaults = HTTP_PROVIDER_DEFAULTS[target.provider];
		// A fallback on the same provider inherits the primary endpoint; a
		// different provider never does (its base URL belongs to another vendor).
		const sameProvider = target.provider === provider;
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
	/** Upstream requests made for this turn, including retries. */
	attempts: number;
	/** The configured primary when a fallback answered; otherwise undefined. */
	switchedFrom?: string;
	/** Cache-relevant token counts, when the provider reported them. */
	usage?: TurnUsage;
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
		usage?: TurnUsage;
	}>({
		targets,
		maxAttempts,
		adaptation,
		health,
		signal,
		buildBody: (target) =>
			buildHttpRequest(
				target.provider,
				target.apiKey,
				effectiveChat(chat, target),
				priorMessages,
				id,
			).body,
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

	const switched = result.target !== primary;
	if (switched) {
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
		attempts: result.attempts,
		switchedFrom: switched ? primary.label : undefined,
		usage: result.value?.usage,
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
	AttemptOutcome & {
		value?: { shadowTexts: string[]; primaryText: string; usage?: TurnUsage };
	}
> {
	const provider = target.provider;
	if (!isHttpProvider(provider)) {
		return {
			ok: false,
			kind: "bad_request",
			message: `未知的协议：${provider}`,
			emittedOutput: false,
		};
	}
	const codec = codecFor(provider);
	// Endpoint and auth headers only: the body is built once per attempt by
	// the orchestrator (with history and the thread cache key) and arrives here
	// already adapted, so the empty history below is never sent.
	const { url, headers } = buildHttpRequest(
		provider,
		target.apiKey,
		effectiveChat(chat, target),
		[],
	);
	const timeoutMs = chat.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	// Per-attempt controller: a failed attempt must cancel its shadows without
	// cancelling the user's turn, while a user cancel still reaches everything.
	const attempt = new AbortController();
	const onAbort = () => attempt.abort();
	signal.addEventListener("abort", onAbort, { once: true });

	// Idle watchdog: it covers the wait for headers and every gap between
	// chunks, so a silent upstream cannot hold the turn forever.
	let timedOut = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const armIdle = (): void => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			timedOut = true;
			attempt.abort();
		}, timeoutMs);
	};
	const disarmIdle = (): void => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
	};

	let emittedOutput = false;
	let terminal = false;
	let malformed = false;
	let failure: StreamError | undefined;
	let usagePatch: UsagePatch | undefined;
	const onSseData = (payload: string) => {
		if (!payload) return;
		for (const frame of codec.parse(payload)) {
			if (frame.malformed) {
				malformed = true;
				continue;
			}
			usagePatch = mergeUsage(usagePatch, frame.usage);
			if (frame.error) {
				failure ??= frame.error;
				continue;
			}
			if (frame.terminal) terminal = true;
			if (frame.text) {
				emittedOutput = true;
				const last = messageParts.at(-1);
				if (last?.type === "text") {
					last.text += frame.text;
				} else {
					messageParts.push({ type: "text", text: frame.text });
				}
				emit({ type: "delta", text: frame.text });
			}
		}
	};

	try {
		// The main request goes first: it is the streamed answer. Shadow
		// variants follow concurrently and are captured, never displayed.
		armIdle();
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
				kind: classifyFailure({ status: response.status, message: detail }),
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

		const stream = await consumeSse(response, onSseData, {
			onChunk: armIdle,
		});
		disarmIdle();
		const streamFailed =
			failure !== undefined || malformed || !stream.complete || !terminal;
		if (streamFailed) {
			// Abandon this attempt's shadows; they are not part of any answer.
			attempt.abort();
			await Promise.all(shadowPromises);
			if (failure) {
				return {
					ok: false,
					kind: failure.kind,
					message: failure.message,
					emittedOutput,
				};
			}
			if (malformed) {
				return {
					ok: false,
					kind: "malformed",
					message: "provider 返回了损坏的 SSE 数据",
					emittedOutput,
				};
			}
			return {
				ok: false,
				kind: "stream",
				message: stream.complete
					? "provider 流没有结束标记，通知保留待重试"
					: "provider SSE 流在完整帧前结束，通知保留待重试",
				emittedOutput,
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
			value: {
				shadowTexts,
				primaryText,
				usage: finalizeUsage(usagePatch),
			},
		};
	} catch (error) {
		if (signal.aborted) throw error;
		if (timedOut) {
			return {
				ok: false,
				kind: "timeout",
				message: `${provider} 在 ${Math.round(timeoutMs / 1000)} 秒内没有返回数据，已放弃该目标`,
				emittedOutput,
			};
		}
		return {
			ok: false,
			kind: "network",
			message: error instanceof Error ? error.message : String(error),
			emittedOutput,
		};
	} finally {
		disarmIdle();
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
