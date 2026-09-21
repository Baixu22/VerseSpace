import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../auth";
import type { TribunalItemView } from "./message-types";
import { useChatStore } from "./store";

vi.mock("../auth", () => ({ apiFetch: vi.fn() }));
const api = vi.mocked(apiFetch);

const ok = (data: unknown) =>
	({ ok: true, status: 200, json: async () => data }) as Response;
const notFound = () =>
	({ ok: false, status: 404, json: async () => ({ ok: false }) }) as Response;

function item(id: string): TribunalItemView {
	return {
		id,
		kind: "workspot_blocked",
		priority: "high",
		state: "pending",
		subject: id,
		sbar: {
			situation: "工位阻塞",
			background: "任务 stale",
			assessment: "空转",
			recommendation: "改派或关闭",
		},
		action: { label: "重新指派" },
		shelveCount: 0,
	};
}

afterEach(() => {
	vi.resetAllMocks();
	useChatStore.setState({ tribunalItems: [] });
});

describe("tribunal slice (TF-0242)", () => {
	it("loadTribunal fills the queue from /api/tribunal", async () => {
		api.mockResolvedValueOnce(ok({ items: [item("ws-a"), item("ws-b")] }));
		await useChatStore.getState().loadTribunal();
		expect(useChatStore.getState().tribunalItems.map((i) => i.id)).toEqual([
			"ws-a",
			"ws-b",
		]);
		expect(api).toHaveBeenCalledWith("/api/tribunal");
	});

	it("resolveTribunal removes the item on success", async () => {
		useChatStore.setState({ tribunalItems: [item("ws-a"), item("ws-b")] });
		api.mockResolvedValueOnce(ok({ ok: true, item: item("ws-a") }));
		await useChatStore.getState().resolveTribunal("ws-a");
		expect(useChatStore.getState().tribunalItems.map((i) => i.id)).toEqual([
			"ws-b",
		]);
		expect(api).toHaveBeenCalledWith("/api/tribunal/ws-a/resolve", {
			method: "POST",
		});
	});

	it("a lost race (404) reconciles from the server instead of dropping blindly", async () => {
		useChatStore.setState({ tribunalItems: [item("ws-a"), item("ws-b")] });
		api
			.mockResolvedValueOnce(notFound()) // resolve ws-a
			.mockResolvedValueOnce(ok({ items: [item("ws-b")] })); // reload
		await useChatStore.getState().resolveTribunal("ws-a");
		expect(useChatStore.getState().tribunalItems.map((i) => i.id)).toEqual([
			"ws-b",
		]);
	});

	it("shelveTribunal posts the minutes and removes the item", async () => {
		useChatStore.setState({ tribunalItems: [item("ws-a")] });
		api.mockResolvedValueOnce(ok({ ok: true, item: item("ws-a") }));
		await useChatStore.getState().shelveTribunal("ws-a", 45);
		expect(useChatStore.getState().tribunalItems).toEqual([]);
		expect(api).toHaveBeenCalledWith("/api/tribunal/ws-a/shelve", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ minutes: 45 }),
		});
	});

	it("a load failure keeps the last-known list rather than blanking the bar", async () => {
		useChatStore.setState({ tribunalItems: [item("ws-a")] });
		api.mockRejectedValueOnce(new Error("network"));
		await useChatStore.getState().loadTribunal();
		expect(useChatStore.getState().tribunalItems.map((i) => i.id)).toEqual([
			"ws-a",
		]);
	});
});
