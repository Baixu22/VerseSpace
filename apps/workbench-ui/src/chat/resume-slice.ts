import type { StateCreator } from "zustand";
import { apiFetch } from "../auth";

import type { ThreadMeta } from "./message-types";

import type { ResumeNote } from "./resume-types";
import { selectionState } from "./selection-state";
import type { ChatState } from "./store-types";

export const createResumeSlice: StateCreator<
	ChatState,
	[],
	[],
	Pick<
		ChatState,
		| "confirmResumeNote"
		| "editResumeBeat"
		| "consumeResumeNote"
		| "dismissResumeCard"
		| "revealResumeCard"
		| "recordResumeAction"
		| "reportResumeCardShown"
		| "adoptBranch"
		| "revertAdoption"
		| "dismissNoticeDelivered"
		| "promoteActive"
	>
> = (set, get) => ({
	async confirmResumeNote() {
		const threadId = get().activeId;
		if (!threadId) {
			return;
		}
		const generation = selectionState.generation;
		const updated = await apiFetch(
			`/api/chat/threads/${threadId}/resume-note`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ confirmed: true }),
			},
		).then((r) => r.json() as Promise<ResumeNote>);
		if (
			generation === selectionState.generation &&
			get().activeId === threadId
		) {
			set({ resumeNote: updated });
		}
	},

	async editResumeBeat(index, text) {
		const threadId = get().activeId;
		const note = get().resumeNote;
		if (!threadId || !note || index < 0 || index >= note.beats.length) {
			return;
		}
		const generation = selectionState.generation;
		const beats = note.beats.map((beat, i) =>
			i === index ? { ...beat, text } : beat,
		);
		const updated = await apiFetch(
			`/api/chat/threads/${threadId}/resume-note`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ beats }),
			},
		).then((r) => r.json() as Promise<ResumeNote>);
		if (
			generation === selectionState.generation &&
			get().activeId === threadId
		) {
			set({ resumeNote: updated });
		}
	},

	async consumeResumeNote(surface) {
		const threadId = get().activeId;
		if (!threadId) {
			return;
		}
		await apiFetch(`/api/chat/threads/${threadId}/resume-note/consume`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ surface }),
		}).catch(() => {});
	},

	async dismissResumeCard() {
		const threadId = get().activeId;
		if (!threadId) {
			return;
		}
		const generation = selectionState.generation;
		set({ resumeCardDismissed: true, resumeCardRevealed: false });
		await apiFetch(`/api/chat/threads/${threadId}/resume-note/dismiss`, {
			method: "POST",
		}).catch(() => {});
		if (
			generation !== selectionState.generation ||
			get().activeId !== threadId
		) {
			return;
		}
	},

	revealResumeCard() {
		set({ resumeCardRevealed: true });
	},

	async recordResumeAction(action, label?) {
		const threadId = get().activeId;
		if (!threadId) {
			return;
		}
		await apiFetch(`/api/chat/threads/${threadId}/resume-action`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(label ? { action, label } : { action }),
		}).catch(() => {});
	},

	async reportResumeCardShown(rows) {
		const threadId = get().activeId;
		if (!threadId || rows.length === 0) {
			return;
		}
		// TF-0325：发通用 `rows`（服务端同时派生 branchRows 供旧折叠器读）；
		// 服务端仍接受旧的 `branchRows` 字段，客户端与旧服务端可混跑。
		await apiFetch(`/api/chat/threads/${threadId}/resume-card/shown`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ rows }),
		}).catch(() => {});
	},

	async adoptBranch(threadId) {
		// threadId 是被收养的分支线程本身：adopt 路由据其 forkOf 反查源线程并归档。
		const response = await apiFetch(`/api/chat/threads/${threadId}/adopt`, {
			method: "POST",
		});
		if (!response.ok) throw new Error("以分支为主线失败，请重试");
		// 收养翻转了两条线程的 archived/forkOf；跳到新主线即触发其 GET 刷新投影。
		await get().switchThread(threadId);
	},

	async revertAdoption(threadId) {
		// threadId 是被归档的源线程本身：revert 路由据其 adoptSnapshot 反查被收养
		// 分支，复归双方身份（源线程解档、分支还原 forkOf）。
		const response = await apiFetch(`/api/chat/threads/${threadId}/revert`, {
			method: "POST",
		});
		if (!response.ok) throw new Error("反转收养失败，请重试");
		// 反转翻回了两条线程的 archived/forkOf；停在这条重新成为主线的源线程并
		// 触发其 GET 刷新投影。
		await get().switchThread(threadId);
	},

	dismissNoticeDelivered() {
		set({ noticesDelivered: null });
	},

	async promoteActive() {
		const threadId = get().activeId;
		if (!threadId || !get().canPromote) return;
		const response = await apiFetch(`/api/chat/threads/${threadId}/promote`, {
			method: "POST",
		});
		if (!response.ok) throw new Error("对话命名失败，请重试");
		const meta = (await response.json()) as ThreadMeta;
		if (meta.id !== threadId) throw new Error("对话命名失败，请重试");
		set((s) => ({
			threads: s.threads.map((thread) =>
				thread.id === threadId ? { ...thread, ...meta } : thread,
			),
			...(s.activeId === threadId ? { canPromote: false } : {}),
		}));
	},
});
