import {
	createInputCoverage,
	recordInputCoverage,
} from "../blackboard/input-coverage";
import { runClaudeTurn } from "./claude-turn";
import { runCodexTurn } from "./codex-turn";
import { runHttp } from "./http-run";
import { noticeParts } from "./notice-parts";
import { ackNotices, drainNotices, selectNoticeEntries } from "./notice-queue";
import { promptWithNotices } from "./prompt";
import { capabilitiesOf } from "./provider-capabilities";
import { decideBinding } from "./thread-binding";
import type { ThreadContext } from "./thread-context";
import { forkLocked } from "./thread-fork";
import { observeForkInheritance } from "./thread-inheritance";
import { maybePromote } from "./thread-promotion";
import type {
	MessagePart,
	RunEvent,
	StoredMessage,
	TurnRunEvent,
} from "./thread-types";
import { readObservabilityOf } from "./thread-types";

export function run(
	context: ThreadContext,
	id: string,
	text: string,
	emit: (event: RunEvent) => void,
	opts: { resend?: boolean } = {},
): Promise<void> {
	return context.store.enqueue(id, async () => {
		const meta = await context.store.get(id);
		const config = await context.bb.config.load();
		const chat = config.chat;
		const capabilities = capabilitiesOf(chat.provider);
		const readObservability = readObservabilityOf(chat.provider);

		// Session binding (phase 2): a protocol change moves this turn to a fork,
		// so the original thread and its cache are never mixed with another
		// protocol's state. Same-protocol changes continue in place.
		const threadMessages = await context.store.messages(id);
		const binding = decideBinding(
			meta.binding,
			threadMessages.length > 0,
			chat,
		);
		if (binding.kind === "fork") {
			const anchor = threadMessages.at(-1);
			const outcome = anchor
				? await forkLocked(context, id, anchor.id)
				: undefined;
			if (!outcome?.ok || !outcome.thread) {
				emit({ type: "error", message: outcome?.reason ?? "无法分叉线程" });
				return;
			}
			await context.store.appendThreadEvent("thread.protocol_forked", id, {
				from: binding.from.provider,
				to: binding.next.provider,
				forkThreadId: outcome.thread.id,
			});
			emit({
				type: "forked",
				threadId: outcome.thread.id,
				title: outcome.thread.title,
			});
			// The fork has no binding yet, so it adopts the configuration and runs
			// the turn itself. `opts` passes through: a resend stays a resend.
			return run(context, outcome.thread.id, text, emit, opts);
		}

		// Drained before the user message is persisted so the notices that get
		// folded into this turn's prompt are recorded on that very message.
		const noticeBatch = await drainNotices(context, id);
		const selectedNotices = selectNoticeEntries(
			noticeBatch.entries,
			chat.noticeTokenBudget,
		);
		const notices = selectedNotices.notices;
		const noticeIds = selectedNotices.entries.map((entry) => entry.id);

		if (!opts.resend) {
			const userNoticeParts = noticeParts(notices);
			const userMessage: StoredMessage = {
				id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				role: "user",
				text,
				at: new Date().toISOString(),
				...(userNoticeParts.length
					? { parts: [...userNoticeParts, { type: "text", text }] }
					: {}),
			};
			await context.store.appendMessage(id, userMessage);
			emit({ type: "user", message: userMessage });
			// TF-0092：对话默认保持无名——命名延迟到触发信号命中的轮次边界
			//（maybePromote），绝不要求用户先命名或分类。
		}

		// TF-0207: the assistant message id is allocated BEFORE the turn runs.
		// Every streaming event carries it and the message is persisted under the
		// same id, so a client can render under the real id from the start
		// instead of patching a placeholder when `done` finally arrives.
		const assistantMessageId = `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		emit({ type: "turn_started", messageId: assistantMessageId });
		// Wrapped once, at the lane boundary: every event a lane emits carries
		// the turn's id without each emitter having to remember it.
		const emitTurn = (event: TurnRunEvent): void =>
			emit({ messageId: assistantMessageId, ...event });

		meta.status = "running";
		if (binding.kind === "bind" || binding.kind === "rebind") {
			meta.binding = binding.next;
		}
		if (binding.kind === "rebind") {
			await context.store.appendThreadEvent("thread.binding_changed", id, {
				reason: binding.reason,
				from: binding.from.model,
				to: binding.next.model,
			});
		}
		meta.lastRun = {
			provider: chat.provider,
			readObservability,
			at: new Date().toISOString(),
		};
		await context.store.saveMeta(meta);

		// Delivery is acknowledged after success, but the model can repair a
		// premise inside that very turn. Capture its causal lower bound now.
		const activityAfterEventId =
			notices.length > 0 ? (await context.bb.events.tail(1))[0]?.id : undefined;
		const acknowledgeDelivery = async (): Promise<boolean> => {
			// Acknowledgement is cleanup, not a provider gate. If the process
			// dies or the lock is busy, keeping the file gives at-least-once
			// delivery and may repeat one notice rather than lose it.
			try {
				const acknowledged = await ackNotices(context, id, noticeIds);
				if (!acknowledged) {
					return false;
				}
				await context.bb.events.append({
					timestamp: new Date().toISOString(),
					source: "runtime",
					type: "premise_notice_delivered",
					payload: {
						writer: id,
						noticeIds,
						count: noticeIds.length,
						...(activityAfterEventId ? { activityAfterEventId } : {}),
						// Reads after a notice come back as footprints on the claude
						// channel. HTTP providers have no tool channel: their
						// post-notice reads are explicitly unobservable, never
						// silently assumed observable (TF-0142).
						readObservability,
					},
				});
				return true;
			} catch (err) {
				// at-least-once 语义保住了（下一轮重投），但失败必须可见，
				// 否则通知通道断裂表现为「再也没有送达信号」（2026-09-13 收尾 4.5）。
				console.error("[chat] premise notice ack failed:", err);
				return false;
			}
		};

		if (capabilities.channel === "local-cli") {
			// Notices are folded into the next user turn (append-only, so the
			// provider's existing context remains cache-safe).
			try {
				if (capabilities.turnRunner === "codex") {
					// TF-0249: the codex lane folds notices into the prompt the same
					// way, then acknowledges delivery only after confirmed success.
					// The framing comes from the shared `promptWithNotices` — an
					// unframed join reads as if the notice text were the user's
					// request.
					const succeeded = await runCodexTurn(
						context,
						id,
						meta,
						promptWithNotices(text, notices),
						emitTurn,
						{ messageId: assistantMessageId },
					);
					if (succeeded && notices.length > 0) await acknowledgeDelivery();
				} else {
					await runClaudeTurn(context, id, meta, text, emitTurn, {
						resend: Boolean(opts.resend),
						precedingNotices: notices,
						onNoticesSent: acknowledgeDelivery,
						messageId: assistantMessageId,
					});
				}
			} catch (error) {
				emitTurn({ type: "error", message: String(error).slice(0, 400) });
				// A spawn/finalization failure must not leave the durable thread
				// marked running forever. The provider notice file remains intact.
				const failed = await context.store.get(id).catch(() => null);
				if (failed) {
					failed.status = "idle";
					await context.store.saveMeta(failed).catch((err) => {
						// 落盘失败 = 线程永远停在 running，UI 的 busy 判定再也
						// 回不到 idle。会话已经出错，这一层不能再静默
						// （2026-09-13 收尾 §4.5 复核判定）。
						console.error(
							`[chat] 线程 ${id} 出错后无法把状态复位为 idle:`,
							err,
						);
					});
				}
			}
			return;
		}

		// ── HTTP providers: OpenAI Chat Completions / Responses, Anthropic ──
		const controller = new AbortController();
		context.running.set(id, controller);
		const messageParts: MessagePart[] = [];
		try {
			const used = await runHttp(
				context,
				chat,
				id,
				emitTurn,
				messageParts,
				controller.signal,
				notices,
				() =>
					observeForkInheritance(context, id, chat.provider, {
						agentContextInherited: true,
						premiseInherited: false,
						mode: "http-history",
					}),
				acknowledgeDelivery,
			);
			// lastRun records the provider that actually answered. A failover
			// can move the turn to a fallback, and the next turn's cache and
			// observability decisions depend on that fact, not the config.
			if (used) {
				meta.lastRun = {
					provider: used.provider,
					readObservability: readObservabilityOf(used.provider),
					at: meta.lastRun?.at ?? new Date().toISOString(),
					attempts: used.attempts,
					switchedFrom: used.switchedFrom,
					usage: used.usage,
				};
				await context.store.saveMeta(meta);
			}
		} catch (error) {
			emitTurn({ type: "error", message: String(error).slice(0, 400) });
		} finally {
			context.running.delete(id);
			await recordInputCoverage(
				context.bb,
				id,
				createInputCoverage("unobservable").finish(),
				assistantMessageId,
			);
			const full = messageParts
				.filter((p): p is { type: "text"; text: string } => p.type === "text")
				.map((p) => p.text)
				.join("");
			if (full) {
				const variants = context.pendingVariants.get(id);
				context.pendingVariants.delete(id);
				const assistantMessage: StoredMessage = {
					// TF-0207: the id the streaming events already announced.
					id: assistantMessageId,
					role: "assistant",
					text: full,
					at: new Date().toISOString(),
					parts: messageParts,
					...(variants?.length ? { variants } : {}),
				};
				await context.store.appendMessage(id, assistantMessage);
				emitTurn({ type: "done", message: assistantMessage });
			} else {
				context.pendingVariants.delete(id);
			}
			const latest = await context.store.get(id);
			latest.status = "idle";
			await context.store.saveMeta(latest);
			// 完成的轮次边界：评估加法式晋升（TF-0092）
			await maybePromote(context, id);
		}
	});
}
