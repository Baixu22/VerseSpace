import type { StateCreator } from "zustand";
import { apiFetch } from "../auth";
import type { StoredMessage } from "./message-types";
import { EMPTY } from "./message-types";
import { refreshThread } from "./refresh-thread";
import type { ChatState } from "./store-types";
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
					index === all.length - 1 &&
					m.status === "complete" &&
					m.role === "assistant"
						? { ...m, text: "", parts: [], status: "running" as const }
						: m,
				),
			},
		}));
		const assistantId = (get().messages[threadId] ?? EMPTY).at(-1)?.id;
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
					const event = JSON.parse(line) as {
						type: string;
						text?: string;
						message?: StoredMessage;
					};
					if (event.type === "delta" && event.text) {
						const current = (get().messages[threadId] ?? EMPTY).find(
							(m) => m.id === assistantId,
						);
						patchAssistant({ text: (current?.text ?? "") + event.text });
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
							text: `⚠ ${event.text ?? "重载失败"}`,
							status: "complete",
						});
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
