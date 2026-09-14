import { afterEach, expect, it, vi } from "vitest";
import { apiFetch } from "../auth";
import { type ThreadMeta, useChatStore } from "./store";

vi.mock("../auth", () => ({ apiFetch: vi.fn() }));
const api = vi.mocked(apiFetch);
const response = (data: unknown) =>
	({ ok: true, json: async () => data }) as Response;
const thread = (id: string): ThreadMeta => ({
	id,
	title: "新对话",
	createdAt: "2026-09-14T00:00:00Z",
	status: "idle",
	permissionMode: "default",
});

afterEach(() => {
	vi.resetAllMocks();
	useChatStore.setState(useChatStore.getInitialState(), true);
});

it("流事件显示真实送达条数，切换后旧对话的事件不能串入当前对话", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
	});
	const first = thread("first");
	useChatStore.setState({ threads: [first], activeId: first.id });
	api.mockImplementation(async (url) => {
		if (url.endsWith("/messages")) return { body: stream } as Response;
		if (url === "/api/chat/threads") return response([first]);
		return response({
			meta: first,
			messages: [],
			suggestions: [],
			decisionPoints: [],
			resumeNote: null,
			resumeDelta: 0,
		});
	});
	const pending = useChatStore.getState().send("继续");
	const emit = (count: number) =>
		controller.enqueue(
			new TextEncoder().encode(
				`${JSON.stringify({ type: "notice_delivered", count })}\n`,
			),
		);
	emit(2);
	await vi.waitFor(() =>
		expect(useChatStore.getState().noticesDelivered?.count).toBe(2),
	);
	useChatStore.setState({ activeId: "second", noticesDelivered: null });
	emit(3);
	controller.close();
	await pending;
	expect(useChatStore.getState().noticesDelivered).toBeNull();
});

it("命名只调用一次服务端入口；切换期间完成时仍更新原对话标题", async () => {
	const first = thread("first");
	const second = thread("second");
	useChatStore.setState({
		threads: [first, second],
		activeId: first.id,
		canPromote: true,
	});
	let resolve!: (value: Response) => void;
	api.mockReturnValue(
		new Promise<Response>((done) => {
			resolve = done;
		}),
	);
	const pending = useChatStore.getState().promoteActive();
	useChatStore.setState({ activeId: second.id, canPromote: true });
	resolve(response({ ...first, title: "修复扫描" }));
	await pending;
	expect(api).toHaveBeenCalledWith("/api/chat/threads/first/promote", {
		method: "POST",
	});
	expect(useChatStore.getState().threads[0]?.title).toBe("修复扫描");
	expect(useChatStore.getState().activeId).toBe(second.id);
	expect(useChatStore.getState().canPromote).toBe(true);
});

it("命名失败可重试，创建和切换立即清除上一对话的命名入口", async () => {
	useChatStore.setState({
		threads: [thread("first")],
		activeId: "first",
		canPromote: true,
	});
	api.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
	await expect(useChatStore.getState().promoteActive()).rejects.toThrow(
		"命名失败",
	);
	expect(useChatStore.getState().canPromote).toBe(true);
	api.mockImplementation(async (url, init) => {
		if (url === "/api/chat/threads" && init?.method === "POST")
			return response(thread("new"));
		return response({
			meta: thread("second"),
			messages: [],
			suggestions: [],
			decisionPoints: [],
			resumeNote: null,
			resumeDelta: 0,
			canPromote: false,
		});
	});
	await useChatStore.getState().createThread();
	expect(useChatStore.getState().canPromote).toBe(false);
	useChatStore.setState({ canPromote: true });
	const pending = useChatStore.getState().switchThread("second");
	expect(useChatStore.getState().canPromote).toBe(false);
	await pending;
});
