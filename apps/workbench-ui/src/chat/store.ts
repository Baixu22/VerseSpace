import { create } from "zustand";

export interface StoredMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	at: string;
	status?: "running" | "complete";
}

export interface ThreadMeta {
	id: string;
	title: string;
	createdAt: string;
	status: "idle" | "running";
}

interface ChatState {
	threads: ThreadMeta[];
	activeId: string | null;
	messages: Record<string, StoredMessage[]>;
	/** The thread with an in-flight run, if any. */
	runningThreadId: string | null;
	init(): Promise<void>;
	createThread(): Promise<void>;
	switchThread(id: string): Promise<void>;
	send(text: string): Promise<void>;
	cancel(): void;
}

const EMPTY: StoredMessage[] = [];

export const useChatStore = create<ChatState>((set, get) => ({
	threads: [],
	activeId: null,
	messages: {},
	runningThreadId: null,

	async init() {
		const threads = await fetch("/api/chat/threads").then(
			(r) => r.json() as Promise<ThreadMeta[]>,
		);
		set({ threads });
		if (threads[0]) {
			await get().switchThread(threads[0].id);
		}
	},

	async createThread() {
		const thread = await fetch("/api/chat/threads", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		}).then((r) => r.json() as Promise<ThreadMeta>);
		set((s) => ({
			threads: [thread, ...s.threads],
			activeId: thread.id,
			messages: { ...s.messages, [thread.id]: [] },
			runningThreadId: null,
		}));
	},

	async switchThread(id) {
		if (get().activeId === id) {
			return;
		}
		set({ activeId: id });
		if (!get().messages[id]) {
			const data = await fetch(`/api/chat/threads/${id}`).then(
				(r) =>
					r.json() as Promise<{ meta: ThreadMeta; messages: StoredMessage[] }>,
			);
			set((s) => ({ messages: { ...s.messages, [id]: data.messages } }));
		}
	},

	cancel() {
		const id = get().runningThreadId;
		if (id) {
			void fetch(`/api/chat/threads/${id}/cancel`, { method: "POST" });
		}
	},

	async send(text) {
		const threadId = get().activeId;
		if (!threadId || get().runningThreadId) {
			return;
		}
		const userMessage: StoredMessage = {
			id: `local-${Date.now()}`,
			role: "user",
			text,
			at: new Date().toISOString(),
			status: "complete",
		};
		const assistantId = `local-a-${Date.now()}`;
		const assistantPlaceholder: StoredMessage = {
			id: assistantId,
			role: "assistant",
			text: "",
			at: new Date().toISOString(),
			status: "running",
		};
		set((s) => ({
			messages: {
				...s.messages,
				[threadId]: [
					...(s.messages[threadId] ?? EMPTY),
					userMessage,
					assistantPlaceholder,
				],
			},
			runningThreadId: threadId,
		}));

		const patchAssistant = (patch: Partial<StoredMessage>) =>
			set((s) => ({
				messages: {
					...s.messages,
					[threadId]: (s.messages[threadId] ?? EMPTY).map((m) =>
						m.id === assistantId ? { ...m, ...patch } : m,
					),
				},
			}));

		try {
			const response = await fetch(`/api/chat/threads/${threadId}/messages`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text }),
			});
			const reader = response.body?.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = (await reader?.read()) ?? {
					done: true,
					value: undefined,
				};
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) {
						continue;
					}
					const event = JSON.parse(line) as {
						type: string;
						text?: string;
						message?: StoredMessage;
						message_meta?: string;
					};
					if (event.type === "delta" && event.text) {
						const current = (get().messages[threadId] ?? EMPTY).find(
							(m) => m.id === assistantId,
						);
						patchAssistant({ text: (current?.text ?? "") + event.text });
					} else if (event.type === "done" && event.message) {
						patchAssistant({
							id: event.message.id,
							text: event.message.text,
							status: "complete",
						});
					} else if (event.type === "error") {
						patchAssistant({
							text:
								(get().messages[threadId] ?? EMPTY).find(
									(m) => m.id === assistantId,
								)?.text + `\n\n⚠ ${event.text ?? "运行出错"}`,
							status: "complete",
						});
					}
				}
			}
		} finally {
			set((s) => ({
				runningThreadId: null,
				threads: s.threads.map((t) =>
					t.id === threadId ? { ...t, status: "idle" as const } : t,
				),
			}));
			// keep the threads sidebar titles fresh (first message renames)
			const threads = await fetch("/api/chat/threads").then(
				(r) => r.json() as Promise<ThreadMeta[]>,
			);
			set({ threads });
		}
	},
}));

export function useActiveMessages(): StoredMessage[] {
	return (
		useChatStore((s) => (s.activeId ? s.messages[s.activeId] : undefined)) ??
		EMPTY
	);
}
