import { afterEach, expect, it, vi } from "vitest";
import { apiFetch } from "../auth";
import { type ThreadMeta, useChatStore } from "./store";

vi.mock("../auth", () => ({ apiFetch: vi.fn() }));
const api = vi.mocked(apiFetch);
const response = (data: unknown) =>
	({ ok: true, json: async () => data }) as Response;
const thread = (id: string, title = "新对话"): ThreadMeta => ({
	id,
	title,
	createdAt: "2026-10-12T00:00:00Z",
	status: "idle",
	permissionMode: "default",
});

afterEach(() => {
	vi.resetAllMocks();
	useChatStore.setState(useChatStore.getInitialState(), true);
});

it("协议切换：forked 之后，源线程撤回占位，后续流式内容落在分叉线程", async () => {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	const stream = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
	});
	const source = thread("source", "原线程");
	const fork = thread("fork", "原线程（分叉）");
	useChatStore.setState({ threads: [source], activeId: source.id });
	api.mockImplementation(async (url) => {
		if (url.endsWith("/messages")) return { body: stream } as Response;
		if (url === "/api/chat/threads") return response([source, fork]);
		const id = url.split("/").at(-1);
		return response({
			meta: id === "fork" ? fork : source,
			messages: [],
			suggestions: [],
			decisionPoints: [],
			resumeNote: null,
			resumeDelta: 0,
		});
	});

	const pending = useChatStore.getState().send("换协议之后的问题");
	const emit = (event: Record<string, unknown>) =>
		controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));

	emit({ type: "forked", threadId: "fork", title: fork.title });
	await vi.waitFor(() => {
		expect(useChatStore.getState().activeId).toBe("fork");
	});
	// 源线程没有本轮消息：乐观占位被撤回
	expect(useChatStore.getState().messages[source.id] ?? []).toEqual([]);
	// 分叉线程上有本轮的用户消息与助手占位
	expect(
		(useChatStore.getState().messages.fork ?? []).map((m) => m.role),
	).toEqual(["user", "assistant"]);

	emit({ type: "turn_started", messageId: "m-fork-1" });
	emit({ type: "delta", text: "新协议的回答", messageId: "m-fork-1" });
	await vi.waitFor(() => {
		expect(useChatStore.getState().messages.fork?.at(-1)?.text).toBe(
			"新协议的回答",
		);
	});
	// 流式内容不会串回源线程
	expect(useChatStore.getState().messages[source.id] ?? []).toEqual([]);

	controller.close();
	await pending;
});
