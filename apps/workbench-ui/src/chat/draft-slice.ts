import type { StateCreator } from "zustand";
import { persistParked } from "./draft-storage";
import type { ChatState } from "./store-types";

export const createDraftSlice: StateCreator<
	ChatState,
	[],
	[],
	Pick<ChatState, "setDraft" | "parkDraft" | "discardParked" | "clearParked">
> = (set) => ({
	setDraft(threadId, text) {
		set((s) => ({ drafts: { ...s.drafts, [threadId]: text } }));
	},

	parkDraft(threadId, text) {
		set((s) => {
			const parked = { ...s.parked };
			const drafts = { ...s.drafts };
			if (text.trim()) {
				parked[threadId] = [
					...(parked[threadId] ?? []),
					{
						id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
						kind: "draft" as const,
						text,
						parkedAt: new Date().toISOString(),
					},
				];
			}
			delete drafts[threadId];
			persistParked(parked);
			return { parked, drafts };
		});
	},

	discardParked(threadId, itemId) {
		set((s) => {
			const parked = {
				...s.parked,
				[threadId]: (s.parked[threadId] ?? []).filter((p) => p.id !== itemId),
			};
			if (parked[threadId]?.length === 0) {
				delete parked[threadId];
			}
			persistParked(parked);
			return { parked };
		});
	},

	clearParked(threadId) {
		set((s) => {
			const parked = { ...s.parked };
			delete parked[threadId];
			persistParked(parked);
			return { parked };
		});
	},
});
