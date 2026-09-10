import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../auth";
import { type ThreadMeta, useChatStore } from "./store";

vi.mock("../auth", () => ({ apiFetch: vi.fn() }));
const api = vi.mocked(apiFetch);

const response = (data: unknown) =>
	({ ok: true, json: async () => data }) as Response;

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
	vi.resetAllMocks();
	reset();
});

describe("追溯式分叉反馈链", () => {
	it("创建后保留源线程，更新锚点计数并提供显式跳转目标", async () => {
		const source = thread("source", "源线程");
		const forked: ThreadMeta = {
			...thread("forked", "分叉线程"),
			forkOf: {
				sourceThreadId: source.id,
				sourceTitle: source.title,
				anchorMessageId: "m-1",
				inheritedMessages: 3,
				at: "2026-09-08T00:01:00.000Z",
			},
		};
		api.mockResolvedValue(
			response({
				ok: true,
				thread: forked,
				declaration: {
					inheritedMessages: 3,
					anchor: {
						id: "m-1",
						role: "assistant",
						at: "2026-09-08T00:00:30.000Z",
					},
					transcriptInherited: true,
					agentContextInherited: null,
					premiseInherited: null,
					inheritanceObserved: false,
					freshAgentSession: true,
					freshPromotion: true,
					freshForkCounts: true,
					freshArchived: true,
				},
			}),
		);
		useChatStore.setState({
			threads: [source],
			activeId: source.id,
			messages: { source: [] },
		});

		const result = await useChatStore.getState().fork("m-1");
		const state = useChatStore.getState();

		expect(result).toBe(forked.id);
		expect(state.activeId).toBe(source.id);
		expect(state.threads[0]).toMatchObject({ id: forked.id });
		expect(state.threads.find((item) => item.id === source.id)?.forks).toEqual({
			"m-1": 1,
		});
		expect(state.forkNotice).toMatchObject({
			threadId: forked.id,
			anchorMessageId: "m-1",
		});
		expect(api).toHaveBeenCalledWith("/api/chat/threads/source/fork", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ anchorMessageId: "m-1" }),
		});
	});
});
