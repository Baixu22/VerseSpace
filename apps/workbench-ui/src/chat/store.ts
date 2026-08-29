import { create } from "zustand";

export type MessagePart =
	| { type: "text"; text: string }
	| {
			type: "tool-call";
			toolCallId: string;
			toolName: string;
			args: unknown;
			result?: unknown;
	  };

export interface StoredMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	at: string;
	status?: "running" | "complete";
	parts?: MessagePart[];
}

export type PermissionMode = "default" | "plan" | "acceptEdits";

export interface ThreadMeta {
	id: string;
	title: string;
	createdAt: string;
	status: "idle" | "running";
	permissionMode: PermissionMode;
	archived?: boolean;
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
	reload(): Promise<void>;
	cancel(): void;
	setPlanMode(enabled: boolean): Promise<void>;
	deleteThread(id: string): Promise<void>;
	setArchived(id: string, archived: boolean): Promise<void>;
	renameThread(id: string, title: string): Promise<void>;
	feedback(messageId: string, kind: "positive" | "negative"): Promise<void>;
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

	async reload() {
		const threadId = get().activeId;
		if (!threadId || get().runningThreadId) {
			return;
		}
		const outcome = await fetch(`/api/chat/threads/${threadId}/reload`, {
			method: "POST",
		}).then(
			(r) =>
				r.json() as Promise<{
					ok: boolean;
					userText?: string;
					reason?: string;
				}>,
		);
		if (!outcome.ok || !outcome.userText) {
			return;
		}
		// server already truncated the trailing assistant message; re-run it
		set((s) => ({
			runningThreadId: threadId,
			messages: {
				...s.messages,
				[threadId]: (s.messages[threadId] ?? EMPTY).map((m, index, all) =>
					index === all.length - 1 &&
					m.status === "complete" &&
					m.role === "assistant"
						? { ...m, text: "", parts: [], status: "running" as const }
						: m,
				),
			},
		}));
		const assistantId = (get().messages[threadId] ?? EMPTY).at(-1)?.id;
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
				body: JSON.stringify({ text: outcome.userText, resend: true }),
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
							parts: event.message.parts,
							status: "complete",
						});
					} else if (event.type === "error") {
						patchAssistant({
							text: `⚠ ${event.text ?? "重载失败"}`,
							status: "complete",
						});
					}
				}
			}
		} finally {
			set({ runningThreadId: null });
		}
	},

	async setPlanMode(enabled: boolean) {
		const id = get().activeId;
		if (!id) {
			return;
		}
		await fetch(`/api/chat/threads/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ permissionMode: enabled ? "plan" : "default" }),
		});
		set((s) => ({
			threads: s.threads.map((t) =>
				t.id === id
					? {
							...t,
							permissionMode: (enabled ? "plan" : "default") as PermissionMode,
						}
					: t,
			),
		}));
	},

	async deleteThread(id: string) {
		await fetch(`/api/chat/threads/${id}`, { method: "DELETE" });
		set((s) => {
			const messages = { ...s.messages };
			delete messages[id];
			const threads = s.threads.filter((t) => t.id !== id);
			return {
				threads,
				messages,
				activeId: s.activeId === id ? (threads[0]?.id ?? null) : s.activeId,
			};
		});
	},

	async setArchived(id: string, archived: boolean) {
		await fetch(`/api/chat/threads/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ archived }),
		});
		set((s) => ({
			threads: s.threads.map((t) => (t.id === id ? { ...t, archived } : t)),
		}));
	},

	async renameThread(id: string, title: string) {
		await fetch(`/api/chat/threads/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title }),
		});
		set((s) => ({
			threads: s.threads.map((t) => (t.id === id ? { ...t, title } : t)),
		}));
	},

	async feedback(messageId: string, kind: "positive" | "negative") {
		const threadId = get().activeId;
		if (!threadId) {
			return;
		}
		await fetch("/api/chat/feedback", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ threadId, messageId, kind }),
		});
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
						part?: MessagePart;
					};
					if (event.type === "delta" && event.text) {
						const current = (get().messages[threadId] ?? EMPTY).find(
							(m) => m.id === assistantId,
						);
						patchAssistant({ text: (current?.text ?? "") + event.text });
					} else if (event.type === "tool" && event.part) {
						// tool-call cards render live while the turn continues
						set((s) => ({
							messages: {
								...s.messages,
								[threadId]: (s.messages[threadId] ?? EMPTY).map((m) =>
									m.id === assistantId
										? {
												...m,
												parts: [...(m.parts ?? []), event.part as MessagePart],
											}
										: m,
								),
							},
						}));
					} else if (event.type === "done" && event.message) {
						patchAssistant({
							id: event.message.id,
							text: event.message.text,
							parts: event.message.parts,
							status: "complete",
						});
					} else if (event.type === "error") {
						patchAssistant({
							text: `${
								(get().messages[threadId] ?? EMPTY).find(
									(m) => m.id === assistantId,
								)?.text
							}\n\n⚠ ${event.text ?? "运行出错"}`,
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
