import type { StateCreator } from "zustand";
import { apiFetch } from "../auth";
import { persistParked } from "./draft-storage";
import type { PermissionMode, ThreadMeta } from "./message-types";
import { selectionState } from "./selection-state";
import type { ChatState, ForkDeclaration } from "./store-types";

export const createThreadSlice: StateCreator<
	ChatState,
	[],
	[],
	Pick<
		ChatState,
		| "cancel"
		| "fork"
		| "dismissForkNotice"
		| "setPlanMode"
		| "deleteThread"
		| "setArchived"
		| "renameThread"
		| "feedback"
	>
> = (set, get) => ({
	cancel() {
		const id = get().runningThreadId;
		if (id) {
			void apiFetch(`/api/chat/threads/${id}/cancel`, { method: "POST" });
		}
	},

	async fork(messageId) {
		const threadId = get().activeId;
		if (!threadId || get().runningThreadId) {
			return null;
		}
		const generation = selectionState.generation;
		const outcome = await apiFetch(`/api/chat/threads/${threadId}/fork`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ anchorMessageId: messageId }),
		}).then(
			(r) =>
				r.json() as Promise<{
					ok: boolean;
					thread?: ThreadMeta;
					declaration?: ForkDeclaration;
				}>,
		);
		if (!outcome.ok || !outcome.thread) {
			return null;
		}
		const forkedThread = outcome.thread;
		// 先入列表：源线程保持可见，用户确认结果后再主动跳转。
		set((s) => ({
			threads: [
				forkedThread,
				...s.threads.filter((item) => item.id !== forkedThread.id),
			],
		}));
		if (
			generation !== selectionState.generation ||
			get().activeId !== threadId
		) {
			return null;
		}
		// Keep the source visible so the success state completes before the user
		// follows the explicit jump action. Creation stays zero-ceremony while
		// navigation remains predictable.
		const d = outcome.declaration;
		set((s) => ({
			threads: s.threads.map((thread) =>
				thread.id === threadId
					? {
							...thread,
							forks: {
								...thread.forks,
								[messageId]: (thread.forks?.[messageId] ?? 0) + 1,
							},
						}
					: thread,
			),
			forkNotice: d
				? {
						text: `已分叉：继承「${forkedThread.forkOf?.sourceTitle ?? "原对话"}」的前 ${d.inheritedMessages} 条消息（含锚点）；agent 会话从新开始，原对话保持不变。`,
						threadId: forkedThread.id,
						anchorMessageId: messageId,
					}
				: null,
		}));
		return forkedThread.id;
	},

	dismissForkNotice() {
		set({ forkNotice: null });
	},

	async setPlanMode(enabled: boolean) {
		const id = get().activeId;
		if (!id) {
			return;
		}
		await apiFetch(`/api/chat/threads/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ permissionMode: enabled ? "plan" : "default" }),
		});
		set((s) => ({
			threads: s.threads.map((t) =>
				t.id === id
					? {
							...t,
							permissionMode: (enabled ? "plan" : "default") as PermissionMode,
						}
					: t,
			),
		}));
	},

	async deleteThread(id: string) {
		// ADR-0012 判据 ③：删除是唯一不可撤销的 GUI 写操作，必须有一次显式确认。
		if (
			!confirm("删除该对话？转录、恢复笔记与派生关系将一并移除，且无法恢复。")
		) {
			return;
		}
		if (get().activeId === id) {
			++selectionState.generation;
		}
		await apiFetch(`/api/chat/threads/${id}`, { method: "DELETE" });
		set((s) => {
			const messages = { ...s.messages };
			delete messages[id];
			const threads = s.threads.filter((t) => t.id !== id);
			const parked = { ...s.parked };
			delete parked[id];
			persistParked(parked);
			const deletingActive = s.activeId === id;
			return {
				threads,
				messages,
				parked,
				activeId: deletingActive ? (threads[0]?.id ?? null) : s.activeId,
				...(deletingActive
					? {
							suggestions: [],
							decisionPoints: [],
							resumeNote: null,
							resumeDelta: 0,
							readSetDiff: null,
							resumeCard: null,
							resumeCardDismissed: false,
							resumeCardRevealed: false,
							noticesDelivered: null,
							canPromote: false,
						}
					: {}),
			};
		});
	},

	async setArchived(id: string, archived: boolean) {
		await apiFetch(`/api/chat/threads/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ archived }),
		});
		set((s) => ({
			threads: s.threads.map((t) => (t.id === id ? { ...t, archived } : t)),
		}));
	},

	async renameThread(id: string, title: string) {
		await apiFetch(`/api/chat/threads/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title }),
		});
		set((s) => ({
			threads: s.threads.map((t) => (t.id === id ? { ...t, title } : t)),
			...(s.activeId === id ? { canPromote: false } : {}),
		}));
	},

	async feedback(messageId: string, kind: "positive" | "negative") {
		const threadId = get().activeId;
		if (!threadId) {
			return;
		}
		await apiFetch("/api/chat/feedback", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ threadId, messageId, kind }),
		});
	},
});
