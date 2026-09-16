import type { StateCreator } from "zustand";
import { apiFetch } from "../auth";
import { persistParked } from "./draft-storage";
import type { ThreadMeta } from "./message-types";
import { selectionState } from "./selection-state";
import type { ChatState, ThreadGetResponse } from "./store-types";

export const createSelectionSlice: StateCreator<
	ChatState,
	[],
	[],
	Pick<ChatState, "init" | "createThread" | "switchThread">
> = (set, get) => ({
	async init() {
		const threads = await apiFetch("/api/chat/threads").then(
			(r) => r.json() as Promise<ThreadMeta[]>,
		);
		set({ threads });
		if (threads[0]) {
			await get().switchThread(threads[0].id);
		}
	},

	async createThread() {
		const generation = ++selectionState.generation;
		const thread = await apiFetch("/api/chat/threads", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		}).then((r) => r.json() as Promise<ThreadMeta>);
		set((s) => {
			const stale = generation !== selectionState.generation;
			return {
				threads: [thread, ...s.threads.filter((item) => item.id !== thread.id)],
				messages: { ...s.messages, [thread.id]: [] },
				...(stale
					? {}
					: {
							activeId: thread.id,
							runningThreadId: null,
							resumeNote: null,
							resumeDelta: 0,
							readSetDiff: null,
							resumeCard: null,
							resumeCardDismissed: false,
							resumeCardRevealed: false,
							noticesDelivered: null,
							canPromote: false,
						}),
			};
		});
	},

	async switchThread(id) {
		if (get().activeId === id) {
			return;
		}
		const generation = ++selectionState.generation;
		// TF-0096 清场：离开的车道收起草稿进停放快照，composer 从干净开始。
		// 返回时快照以可筛选列表呈现，恢复或丢弃由用户决定。
		const prevId = get().activeId;
		set((s) => {
			const parked = { ...s.parked };
			const drafts = { ...s.drafts };
			const prev = s.activeId;
			if (prev) {
				const text = (drafts[prev] ?? "").trim();
				if (text) {
					parked[prev] = [
						...(parked[prev] ?? []),
						{
							id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
							kind: "draft" as const,
							text,
							parkedAt: new Date().toISOString(),
						},
					];
				}
				delete drafts[prev];
			}
			persistParked(parked);
			return {
				parked,
				drafts,
				activeId: id,
				forkNotice: null,
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
			};
		});
		// TF-0097：离开 prev 时 fire-and-forget 生成恢复笔记（agent 起草）。
		// 不阻塞切换、失败吞掉——笔记是余光，不是切换的前置条件。
		if (prevId && prevId !== id) {
			void apiFetch(`/api/chat/threads/${prevId}/leave`, {
				method: "POST",
			}).catch(() => {});
		}
		const data = await apiFetch(`/api/chat/threads/${id}`).then(
			(r) => r.json() as Promise<ThreadGetResponse>,
		);
		if (generation !== selectionState.generation || get().activeId !== id) {
			return;
		}
		set((s) => {
			// TF-0097：返回时检测『你不在时变了什么』——读数由服务端算好随载荷
			// 下发（chat/resume.ts 的 resumeDelta() 是唯一来源），客户端不再内联
			// 重算同一算式（2026-09-13 收尾 §5.6）。
			return {
				messages: { ...s.messages, [id]: data.messages },
				suggestions: data.suggestions,
				decisionPoints: data.decisionPoints,
				resumeNote: data.resumeNote,
				resumeDelta: data.resumeDelta ?? 0,
				readSetDiff: data.readSetDiff ?? null,
				resumeCard: data.resumeCard ?? null,
				resumeCardDismissed: Boolean(data.resumeCardDismissed),
				resumeCardRevealed: false,
				canPromote: Boolean(data.canPromote),
				noticesDelivered: null,
				threads: s.threads.some((t) => t.id === id)
					? s.threads.map((t) => (t.id === id ? { ...t, ...data.meta } : t))
					: [data.meta, ...s.threads],
			};
		});
		if (generation !== selectionState.generation || get().activeId !== id) {
			return;
		}
		// Lifecycle observations are best-effort and only record a switch that
		// actually loaded its target; stale/failed races must not inflate stats.
		await apiFetch(`/api/chat/threads/${id}/switch`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ fromThreadId: prevId }),
		}).catch(() => {});
		if (generation !== selectionState.generation || get().activeId !== id) {
			return;
		}
		await apiFetch(`/api/chat/threads/${id}/restore`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				fromThreadId: prevId,
				resumeCardVisible: Boolean(
					data.resumeCard && !data.resumeCardDismissed,
				),
				lastMessageId: data.messages.at(-1)?.id ?? null,
			}),
		}).catch(() => {});
	},
});
