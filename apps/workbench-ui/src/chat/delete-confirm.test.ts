import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../auth";
import { type ThreadMeta, useChatStore } from "./store";

vi.mock("../auth", () => ({ apiFetch: vi.fn() }));
const api = vi.mocked(apiFetch);

function thread(id: string, title: string): ThreadMeta {
	return {
		id,
		title,
		createdAt: "2026-09-08T00:00:00.000Z",
		status: "idle",
		permissionMode: "default",
	};
}

function reset(): void {
	useChatStore.setState({
		threads: [],
		activeId: null,
		messages: {},
		runningThreadId: null,
		forkNotice: null,
		suggestions: [],
		decisionPoints: [],
		drafts: {},
		parked: {},
		resumeNote: null,
		resumeDelta: 0,
		readSetDiff: null,
		resumeCard: null,
		resumeCardDismissed: false,
		resumeCardRevealed: false,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	reset();
});

describe("删除确认闸（ADR-0012 判据 ③）", () => {
	it("用户取消时不发 DELETE，线程保留", async () => {
		const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
		const target = thread("doomed", "要删的");
		useChatStore.setState({ threads: [target], activeId: target.id });

		await useChatStore.getState().deleteThread(target.id);

		expect(confirmSpy).toHaveBeenCalledOnce();
		expect(api).not.toHaveBeenCalled();
		expect(useChatStore.getState().threads).toHaveLength(1);
	});

	it("用户确认后才发 DELETE 并清理本地状态", async () => {
		vi.spyOn(window, "confirm").mockReturnValue(true);
		api.mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
		const target = thread("doomed", "要删的");
		useChatStore.setState({
			threads: [target, thread("other", "留着")],
			activeId: target.id,
			messages: { doomed: [], other: [] },
		});

		await useChatStore.getState().deleteThread(target.id);
		const state = useChatStore.getState();

		expect(api).toHaveBeenCalledWith("/api/chat/threads/doomed", {
			method: "DELETE",
		});
		expect(state.threads.map((t) => t.id)).toEqual(["other"]);
		expect(state.activeId).toBe("other");
	});
});
