import type { StoreApi } from "zustand";
import { apiFetch } from "../auth";
import type { ChatState, ThreadGetResponse } from "./store-types";
export async function refreshThread(
	set: StoreApi<ChatState>["setState"],
	threadId: string,
): Promise<void> {
	const data = await apiFetch(`/api/chat/threads/${threadId}`).then(
		(r) => r.json() as Promise<ThreadGetResponse>,
	);
	set((s) => ({
		messages: { ...s.messages, [threadId]: data.messages },
		...(s.activeId === threadId
			? {
					suggestions: data.suggestions,
					decisionPoints: data.decisionPoints,
					readSetDiff: data.readSetDiff ?? null,
					artifactReviews: data.artifactReviews ?? null,
					resumeCard: data.resumeCard ?? null,
					resumeCardDismissed: Boolean(data.resumeCardDismissed),
					resumeDelta: data.resumeDelta ?? 0,
					continuityDelivery: data.continuityDelivery
						? {
								pendingNotices: data.continuityDelivery.pendingNotices,
								priority: data.continuityDelivery.priority ?? "neither",
							}
						: null,
					canPromote: Boolean(data.canPromote),
				}
			: {}),
		threads: s.threads.map((t) =>
			t.id === threadId ? { ...t, ...data.meta } : t,
		),
	}));
}
