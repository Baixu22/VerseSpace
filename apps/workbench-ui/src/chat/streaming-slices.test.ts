import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../auth";
import type {
	ChatRunEvent,
	CollapsedGroupPart,
	StoredMessage,
	ThreadMeta,
} from "./message-types";
import { useChatStore } from "./store";

vi.mock("../auth", () => ({ apiFetch: vi.fn() }));
const api = vi.mocked(apiFetch);
const response = (data: unknown) => ({ json: async () => data }) as Response;
const thread: ThreadMeta = {
	id: "thread-1",
	title: "Test",
	createdAt: "2026-09-18T00:00:00.000Z",
	status: "idle",
	permissionMode: "default",
};
const user: StoredMessage = {
	id: "user-1",
	role: "user",
	text: "Continue",
	at: thread.createdAt,
};
const group: CollapsedGroupPart = {
	type: "collapsed-group",
	id: "group:read-1",
	category: "read",
	summary: "读取 1 个文件",
	active: true,
	tools: [
		{
			type: "tool-call",
			toolCallId: "read-1",
			toolName: "Read",
			args: { file_path: "src/main.ts" },
		},
	],
};
const messageId = "assistant-1";
const messagesOf = () => useChatStore.getState().messages[thread.id] ?? [];
const assistant = () => messagesOf().at(-1);

afterEach(() => {
	vi.resetAllMocks();
	useChatStore.setState(useChatStore.getInitialState(), true);
});

async function start(mode: "send" | "reload") {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let persisted: StoredMessage[] = [];
	const stream = new ReadableStream<Uint8Array>({
		start(value) {
			controller = value;
		},
	});
	useChatStore.setState({
		threads: [thread],
		activeId: thread.id,
		messages: {
			[thread.id]:
				mode === "reload"
					? [
							user,
							{
								id: "previous-assistant",
								role: "assistant",
								text: "Old answer",
								at: thread.createdAt,
								parts: [group],
								variants: ["Old alternative"],
							},
						]
					: [],
		},
	});
	api.mockImplementation(async (url) => {
		if (url.endsWith("/reload"))
			return response({ ok: true, userText: user.text });
		if (url.endsWith("/messages")) return { body: stream } as Response;
		if (url === "/api/chat/threads") return response([thread]);
		return response({
			meta: thread,
			messages: persisted,
			suggestions: [],
			decisionPoints: [],
			resumeNote: null,
		});
	});
	const pending =
		mode === "send"
			? useChatStore.getState().send(user.text)
			: useChatStore.getState().reload();
	await vi.waitFor(() => expect(assistant()?.status).toBe("running"));
	return {
		emit(event: ChatRunEvent) {
			controller.enqueue(
				new TextEncoder().encode(`${JSON.stringify(event)}\n`),
			);
		},
		async finish(messages = messagesOf()) {
			persisted = messages;
			controller.close();
			await pending;
		},
	};
}

describe.each(["send", "reload"] as const)("%s streaming", (mode) => {
	it("uses the same ordered reducer live, then the persisted history shape", async () => {
		const run = await start(mode);
		expect(assistant()?.text).toBe("");
		expect(assistant()?.parts ?? []).toEqual([]);
		expect(assistant()?.variants).toBeUndefined();
		expect(api).toHaveBeenCalledWith(
			`/api/chat/threads/${thread.id}/messages`,
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					text: user.text,
					...(mode === "reload" ? { resend: true } : {}),
				}),
			}),
		);
		if (mode === "send") run.emit({ type: "user", message: user });
		run.emit({ type: "turn_started", messageId });
		run.emit({ type: "delta", messageId, text: "Draft intro" });
		await vi.waitFor(() =>
			expect(assistant()).toMatchObject({
				id: messageId,
				text: "Draft intro",
				parts: [{ type: "text", text: "Draft intro" }],
			}),
		);
		const parts = [{ type: "text" as const, text: "Corrected intro" }, group];
		run.emit({ type: "parts", messageId, parts });
		await vi.waitFor(() =>
			expect(assistant()).toMatchObject({ text: "Corrected intro", parts }),
		);
		run.emit({ type: "delta", messageId, text: "\nAnswer" });
		run.emit({ type: "delta", messageId, text: "." });
		await vi.waitFor(() =>
			expect(assistant()).toMatchObject({
				text: "Corrected intro\nAnswer.",
				parts: [...parts, { type: "text", text: "\nAnswer." }],
			}),
		);
		// Full snapshots replace the running group too, including tool results.
		const completedGroup = {
			...group,
			active: false,
			tools: group.tools.map((tool) => ({ ...tool, result: "File contents" })),
		};
		const completedParts = [
			parts[0]!,
			completedGroup,
			{ type: "text" as const, text: "\nAnswer." },
		];
		run.emit({ type: "parts", messageId, parts: completedParts });
		await vi.waitFor(() => expect(assistant()?.parts).toEqual(completedParts));
		const stored: StoredMessage = {
			id: messageId,
			role: "assistant",
			at: "2026-09-18T01:00:00.000Z",
			text: "Final intro\nFinal answer",
			parts: [
				{ type: "text", text: "Final intro" },
				completedGroup,
				{ type: "text", text: "\nFinal answer" },
			],
			variants: ["Alternative"],
		};
		run.emit({ type: "done", messageId, message: stored });
		await vi.waitFor(() =>
			expect(assistant()).toEqual({ ...stored, status: "complete" }),
		);
		expect(messagesOf()).toHaveLength(2);
		expect(messagesOf()[0]).toMatchObject(user);
		await run.finish([user, stored]);
		expect(useChatStore.getState().runningThreadId).toBeNull();
		expect(assistant()).toEqual(stored);
	});

	it("shows error.message after streamed tools without erasing prior text", async () => {
		const run = await start(mode);
		run.emit({ type: "turn_started", messageId });
		run.emit({
			type: "parts",
			messageId,
			parts: [{ type: "text", text: "Before" }, group],
		});
		run.emit({ type: "error", messageId, message: "Provider disconnected" });
		await vi.waitFor(() =>
			expect(assistant()).toMatchObject({
				text: "Before\n\n运行出错：Provider disconnected",
				status: "complete",
				parts: [
					{ type: "text", text: "Before" },
					group,
					{ type: "text", text: "\n\n运行出错：Provider disconnected" },
				],
			}),
		);
		await run.finish();
	});

	it("shows pre-turn errors on the local draft when the server has no messageId", async () => {
		const run = await start(mode);
		const placeholderId = assistant()?.id;
		run.emit({ type: "error", message: "Thread not found" });
		await vi.waitFor(() =>
			expect(assistant()).toMatchObject({
				id: placeholderId,
				status: "complete",
				text: "运行出错：Thread not found",
				parts: [{ type: "text", text: "运行出错：Thread not found" }],
			}),
		);
		await run.finish();
	});
});
