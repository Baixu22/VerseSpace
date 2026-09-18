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

it("turn_started 把占位 id 换成服务端 id：后续事件与 done 都落在同一条消息上", async () => {
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
	const messagesOf = () => useChatStore.getState().messages[first.id] ?? [];

	// 发送后先有两条占位（用户 + 助手），助手此时还是本地 id
	expect(messagesOf().map((message) => message.role)).toEqual([
		"user",
		"assistant",
	]);
	expect(messagesOf().at(-1)?.id.startsWith("local-a-")).toBe(true);

	const emit = (event: Record<string, unknown>) =>
		controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));

	// 服务端在回合开始就给出真 id —— 占位立刻让位
	emit({ type: "turn_started", messageId: "m-server-1" });
	await vi.waitFor(() => {
		expect(messagesOf().at(-1)?.id).toBe("m-server-1");
	});

	emit({ type: "delta", text: "你好", messageId: "m-server-1" });
	await vi.waitFor(() => {
		expect(messagesOf().at(-1)?.text).toBe("你好");
	});

	// done 带着同一个 id：命中同一条消息，不会多出一条，也不需要二次匹配。
	// 断言在回合事件处理完的那一刻做 —— `await pending` 之后 store 会按服务端
	// 快照重取（这个 mock 返回空列表），而 TF-0207 要证的正是这一刻的 id 一致。
	emit({
		type: "done",
		messageId: "m-server-1",
		message: {
			id: "m-server-1",
			role: "assistant",
			text: "你好",
			at: "2026-09-18T00:00:00.000Z",
		},
	});
	await vi.waitFor(() => {
		const messages = messagesOf();
		expect(messages).toHaveLength(2);
		expect(messages.at(-1)?.id).toBe("m-server-1");
		expect(messages.at(-1)?.status).toBe("complete");
	});
	controller.close();
	await pending;
});
