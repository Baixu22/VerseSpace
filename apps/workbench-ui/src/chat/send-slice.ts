import type { StateCreator } from "zustand";
import { apiFetch } from "../auth";
import type { MessagePart, StoredMessage, ThreadMeta } from "./message-types";
import { EMPTY } from "./message-types";
import { refreshThread } from "./refresh-thread";

import { selectionState } from "./selection-state";
import type { ChatState } from "./store-types";
export const createSendSlice: StateCreator<
	ChatState,
	[],
	[],
	Pick<ChatState, "send">
> = (set, get) => ({
	async send(text) {
		const threadId = get().activeId;
		if (!threadId || get().runningThreadId) {
			return;
		}
		const generation = selectionState.generation;
		const userMessage: StoredMessage = {
			id: `local-${Date.now()}`,
			role: "user",
			text,
			at: new Date().toISOString(),
			status: "complete",
		};
		// TF-0207: replaced by the server's turn id as soon as `turn_started`
		// arrives; until then the placeholder is what patches address.
		let assistantId = `local-a-${Date.now()}`;
		const placeholderId = assistantId;
		const assistantPlaceholder: StoredMessage = {
			id: assistantId,
			role: "assistant",
			text: "",
			at: new Date().toISOString(),
			status: "running",
		};
		set((s) => ({
			messages: {
				...s.messages,
				[threadId]: [
					...(s.messages[threadId] ?? EMPTY),
					userMessage,
					assistantPlaceholder,
				],
			},
			runningThreadId: threadId,
		}));

		const patchAssistant = (patch: Partial<StoredMessage>) =>
			set((s) => ({
				messages: {
					...s.messages,
					[threadId]: (s.messages[threadId] ?? EMPTY).map((m) =>
						m.id === assistantId ? { ...m, ...patch } : m,
					),
				},
			}));

		try {
			const response = await apiFetch(
				`/api/chat/threads/${threadId}/messages`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text }),
				},
			);
			const reader = response.body?.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = (await reader?.read()) ?? {
					done: true,
					value: undefined,
				};
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) {
						continue;
					}
					const event = JSON.parse(line) as {
						type: string;
						text?: string;
						messageId?: string;
						message?: StoredMessage;
						part?: MessagePart;
						count?: number;
					};
					if (event.type === "user" && event.message) {
						// 服务器确认了用户消息（真实持久化 id）——换掉本地占位
						// id，消息操作（分叉锚点等）必须用服务端 id
						set((s) => ({
							messages: {
								...s.messages,
								[threadId]: (s.messages[threadId] ?? EMPTY).map((m) =>
									m.id === userMessage.id
										? { ...event.message!, status: "complete" as const }
										: m,
								),
							},
						}));
					} else if (
						event.type === "turn_started" &&
						typeof event.messageId === "string"
					) {
						// TF-0207: 服务端在回合开始就把消息 id 给了我们 —— 占位立刻
						// 换成真 id，之后 delta/tool/done 全用同一个 id，
						// done 到达时不再需要二次匹配（此前是 done 才替换 id）。
						const realId = event.messageId;
						set((s) => ({
							messages: {
								...s.messages,
								[threadId]: (s.messages[threadId] ?? EMPTY).map((m) =>
									m.id === placeholderId ? { ...m, id: realId } : m,
								),
							},
						}));
						assistantId = realId;
					} else if (event.type === "delta" && event.text) {
						const current = (get().messages[threadId] ?? EMPTY).find(
							(m) => m.id === assistantId,
						);
						patchAssistant({ text: (current?.text ?? "") + event.text });
					} else if (event.type === "tool" && event.part) {
						// tool-call cards render live while the turn continues
						set((s) => ({
							messages: {
								...s.messages,
								[threadId]: (s.messages[threadId] ?? EMPTY).map((m) =>
									m.id === assistantId
										? {
												...m,
												parts: [...(m.parts ?? []), event.part as MessagePart],
											}
										: m,
								),
							},
						}));
					} else if (event.type === "tool_result" && event.part) {
						// 工具结果即时回填：此前客户端只分支 user/delta/tool/done/error，
						// 结果要等 done 整条替换才可见（2026-09-13 收尾 4.3）。
						const part = event.part;
						set((s) => ({
							messages: {
								...s.messages,
								[threadId]: (s.messages[threadId] ?? EMPTY).map((m) =>
									m.id === assistantId
										? {
												...m,
												parts: (m.parts ?? []).map((p) =>
													p.type === "tool-call" &&
													part.type === "tool-call" &&
													p.toolCallId === part.toolCallId
														? part
														: p,
												),
											}
										: m,
								),
							},
						}));
					} else if (event.type === "notice_delivered") {
						// Background runs must not show delivery on a different conversation.
						if (
							get().activeId === threadId &&
							Number.isInteger(event.count) &&
							event.count! > 0
						) {
							set({
								noticesDelivered: {
									count: event.count!,
									at: new Date().toISOString(),
								},
							});
						}
					} else if (event.type === "done" && event.message) {
						patchAssistant({
							id: event.message.id,
							text: event.message.text,
							parts: event.message.parts,
							variants: event.message.variants,
							status: "complete",
						});
					} else if (event.type === "error") {
						patchAssistant({
							text: `${
								(get().messages[threadId] ?? EMPTY).find(
									(m) => m.id === assistantId,
								)?.text
							}\n\n⚠ ${event.text ?? "运行出错"}`,
							status: "complete",
						});
					}
				}
			}
		} finally {
			set((s) => ({
				runningThreadId:
					s.runningThreadId === threadId ? null : s.runningThreadId,
				threads: s.threads.map((t) =>
					t.id === threadId ? { ...t, status: "idle" as const } : t,
				),
			}));
			// keep the threads sidebar titles fresh (first message renames)
			const threads = await apiFetch("/api/chat/threads").then(
				(r) => r.json() as Promise<ThreadMeta[]>,
			);
			if (generation === selectionState.generation) {
				set({ threads });
			}
			// 轮次边界刷新：meta + 建议 + 决策账本（TF-0095）
			await refreshThread(set, threadId);
		}
	},
});
