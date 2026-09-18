import type { StateCreator } from "zustand";
import { apiFetch } from "../auth";
import type { ChatRunEvent, StoredMessage, ThreadMeta } from "./message-types";
import { EMPTY } from "./message-types";
import { refreshThread } from "./refresh-thread";
import { selectionState } from "./selection-state";
import type { ChatState } from "./store-types";
import { applyAssistantRunEvent, isAssistantRunEvent } from "./stream-reducer";
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
					const event = JSON.parse(line) as ChatRunEvent;
					if (event.type === "user") {
						// 服务器确认了用户消息（真实持久化 id）——换掉本地占位
						// id，消息操作（分叉锚点等）必须用服务端 id
						set((s) => ({
							messages: {
								...s.messages,
								[threadId]: (s.messages[threadId] ?? EMPTY).map((m) =>
									m.id === userMessage.id
										? { ...event.message, status: "complete" as const }
										: m,
								),
							},
						}));
					} else if (event.type === "turn_started") {
						// TF-0207: replace the local placeholder before any assistant
						// delta/parts/done event uses the server's stable turn id.
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
					} else if (event.type === "notice_delivered") {
						// Background runs must not show delivery on a different conversation.
						if (
							get().activeId === threadId &&
							Number.isInteger(event.count) &&
							event.count > 0
						) {
							set({
								noticesDelivered: {
									count: event.count,
									at: new Date().toISOString(),
								},
							});
						}
					} else if (isAssistantRunEvent(event)) {
						set((s) => ({
							messages: {
								...s.messages,
								[threadId]: (s.messages[threadId] ?? EMPTY).map((message) =>
									message.id === assistantId
										? applyAssistantRunEvent(message, event)
										: message,
								),
							},
						}));
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
