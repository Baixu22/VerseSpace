import type { StateCreator } from "zustand";
import { apiFetch } from "../auth";
import type { TribunalItemView } from "./message-types";
import type { ChatState } from "./store-types";

/**
 * The tribunal queue in chat (TF-0242). The queue is global to the ledger, so
 * this slice is not thread-scoped: `loadTribunal` pulls every unresolved item,
 * and resolve / shelve go through the same ledger API the CLI uses. Feedback is
 * the item leaving the list — the durable receipt is the `tribunal_resolved` /
 * `tribunal_shelved` event, not a mutation of any chat transcript.
 */
export const createTribunalSlice: StateCreator<
	ChatState,
	[],
	[],
	Pick<
		ChatState,
		"tribunalItems" | "loadTribunal" | "resolveTribunal" | "shelveTribunal"
	>
> = (set, get) => ({
	tribunalItems: [],
	async loadTribunal() {
		try {
			const body = (await apiFetch("/api/tribunal").then((r) => r.json())) as {
				items: TribunalItemView[];
			};
			set({ tribunalItems: body.items ?? [] });
		} catch {
			// A transient load failure leaves the last-known list in place rather
			// than blanking the bar; the next turn boundary retries.
		}
	},
	async resolveTribunal(id: string) {
		const response = await apiFetch(`/api/tribunal/${id}/resolve`, {
			method: "POST",
		});
		if (response.ok) {
			set((s) => ({
				tribunalItems: s.tribunalItems.filter((item) => item.id !== id),
			}));
		} else {
			// Lost a race (already resolved elsewhere): reconcile from the server.
			await get().loadTribunal();
		}
	},
	async shelveTribunal(id: string, minutes?: number) {
		const response = await apiFetch(`/api/tribunal/${id}/shelve`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(minutes === undefined ? {} : { minutes }),
		});
		if (response.ok) {
			set((s) => ({
				tribunalItems: s.tribunalItems.filter((item) => item.id !== id),
			}));
		} else {
			await get().loadTribunal();
		}
	},
});
