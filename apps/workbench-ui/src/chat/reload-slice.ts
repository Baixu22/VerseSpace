import type { StateCreator } from "zustand";
import { apiFetch } from "../auth";
import type { ChatRunEvent } from "./message-types";
import { EMPTY } from "./message-types";
import { refreshThread } from "./refresh-thread";
import type { ChatState } from "./store-types";
import { applyAssistantRunEvent, isAssistantRunEvent } from "./stream-reducer";
export const createReloadSlice: StateCreator<
	ChatState,
	[],
	[],
	Pick<ChatState, "reload">
> = (set, get) => ({
	async reload() {
		const threadId = get().activeId;
		if (!threadId || get().runningThreadId) {
			return;
		}
		const outcome = await apiFetch(`/api/chat/threads/${threadId}/reload`, {
			method: "POST",
		}).then(
			(r) =>
				r.json() as Promise<{
					ok: boolean;
					userText?: string;
					reason?: string;
				}>,
		);
		if (!outcome.ok || !outcome.userText) {
			return;
		}
		// server already truncated the trailing assistant message; re-run it
		set((s) => ({
			runningThreadId: threadId,
			messages: {
				...s.messages,
				[threadId]: (s.messages[threadId] ?? EMPTY).map((m, index, all) =>
					index === all.length - 1 && m.role === "assistant"
						? {
								id: m.id,
								role: m.role,
								text: "",
								at: new Date().toISOString(),
								parts: [],
								status: "running" as const,
							}
						: m,
				),
			},
		}));
		let assistantId = (get().messages[threadId] ?? EMPTY).at(-1)?.id;
		try {
			const response = await apiFetch(
				`/api/chat/threads/${threadId}/messages`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text: outcome.userText, resend: true }),
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
					if (
						event.type === "turn_started" &&
						assistantId &&
						event.messageId !== assistantId
					) {
						const previousId = assistantId;
						assistantId = event.messageId;
						set((state) => ({
							messages: {
								...state.messages,
								[threadId]: (state.messages[threadId] ?? EMPTY).map(
									(message) =>
										message.id === previousId
											? { ...message, id: event.messageId }
											: message,
								),
							},
						}));
					} else if (isAssistantRunEvent(event)) {
						set((state) => ({
							messages: {
								...state.messages,
								[threadId]: (state.messages[threadId] ?? EMPTY).map(
									(message) =>
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
			}));
			// 轮次边界刷新：meta（标题/晋升）+ 建议 + 决策账本（TF-0095）
			await refreshThread(set, threadId);
		}
	},
});
