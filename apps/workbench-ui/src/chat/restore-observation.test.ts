import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../auth";
import type { ArtifactReviewProjectionView } from "./resume-types";
import { type ResumeCardView, useChatStore } from "./store";

vi.mock("../auth", () => ({ apiFetch: vi.fn() }));
const api = vi.mocked(apiFetch);
const response = (data: unknown) =>
	({ ok: true, json: async () => data }) as Response;
const card: ResumeCardView = {
	coverage: { status: "unknown", text: "覆盖范围未知" },
	narrative: [],
	facts: [],
	dismissed: false,
	inject: true,
	factsPreviewCount: 3,
};
const artifacts: ArtifactReviewProjectionView = {
	schemaVersion: 1,
	total: 1,
	counts: { current: 0, stale: 1, pending: 0, failed: 0, unknown: 0 },
	items: [],
	omitted: 0,
	truncated: false,
};

function view(
	id: string,
	resumeCard: ResumeCardView | null,
	dismissed = false,
	artifactReviews: ArtifactReviewProjectionView | null = null,
) {
	return {
		meta: {
			id,
			title: id,
			createdAt: "2026-09-07T00:00:00Z",
			status: "idle",
			permissionMode: "default",
		},
		messages: [
			{
				id: "last-loaded",
				role: "assistant",
				text: "已记录",
				at: "2026-09-07T00:00:00Z",
			},
		],
		suggestions: [],
		decisionPoints: [],
		resumeNote: null,
		resumeCard,
		resumeCardDismissed: dismissed,
		artifactReviews,
	};
}

afterEach(() => {
	vi.resetAllMocks();
	useChatStore.setState({
		activeId: null,
		threads: [],
		messages: {},
		drafts: {},
		parked: {},
		artifactReviews: null,
		resumeCard: null,
		resumeCardDismissed: false,
	});
});

describe("恢复耗时的 UI 观测", () => {
	it.each([
		{ label: "有卡", resumeCard: card, dismissed: false, visible: true },
		{ label: "卡已收起", resumeCard: card, dismissed: true, visible: false },
		{ label: "无卡", resumeCard: null, dismissed: false, visible: false },
		{
			label: "仅产物卡",
			resumeCard: null,
			dismissed: true,
			artifactReviews: artifacts,
			visible: true,
		},
	])("$label：带上实际可见性和加载时的消息边界", async ({
		resumeCard,
		dismissed,
		artifactReviews = null,
		visible,
	}) => {
		api.mockImplementation(async (path) =>
			response(
				path === "/api/chat/threads/target"
					? view("target", resumeCard, dismissed, artifactReviews)
					: { ok: true },
			),
		);
		await useChatStore.getState().switchThread("target");
		const call = api.mock.calls.find(([path]) => path.endsWith("/restore"));
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({
			fromThreadId: null,
			resumeCardVisible: visible,
			lastMessageId: "last-loaded",
		});
	});

	it("慢请求已过时，不记录那个线程的恢复样本", async () => {
		let release!: (value: Response) => void;
		const pending = new Promise<Response>((resolve) => {
			release = resolve;
		});
		api.mockImplementation(async (path) => {
			if (path === "/api/chat/threads/slow") return pending;
			return response(
				path === "/api/chat/threads/fast" ? view("fast", null) : { ok: true },
			);
		});
		const slow = useChatStore.getState().switchThread("slow");
		await useChatStore.getState().switchThread("fast");
		release(response(view("slow", card)));
		await slow;
		expect(
			api.mock.calls
				.filter(([path]) => path.endsWith("/restore"))
				.map(([path]) => path),
		).toEqual(["/api/chat/threads/fast/restore"]);
		expect(useChatStore.getState().activeId).toBe("fast");
	});
});
