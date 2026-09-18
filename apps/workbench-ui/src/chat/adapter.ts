import {
	type ThreadMessage,
	type ThreadMessageLike,
	useExternalStoreRuntime,
	WebSpeechSynthesisAdapter,
} from "@assistant-ui/react";
import { useState } from "react";
import { type StoredMessage, useActiveMessages, useChatStore } from "./store";

export function toThreadMessage(m: StoredMessage): ThreadMessageLike {
	const content = (m.parts ?? [{ type: "text", text: m.text }]).map((part) => {
		if (part.type === "tool-call") {
			return {
				type: "tool-call" as const,
				toolCallId: part.toolCallId,
				toolName: part.toolName,
				result: part.result,
				isError: part.isError,
				argsText: JSON.stringify(part.args, null, 2) ?? "{}",
			};
		}
		if (part.type === "collapsed-group") {
			return {
				type: "data-workbench-collapsed-group" as const,
				data: part,
			};
		}
		return { type: "text" as const, text: part.text };
	});
	// external store rule: status is only supported for assistant messages —
	// a status on user messages throws at convertMessages
	const isAssistant = m.role === "assistant";
	return {
		id: m.id,
		role: m.role === "user" ? "user" : "assistant",
		content,
		...(isAssistant
			? {
					status:
						m.status === "running"
							? ({ type: "running" } as const)
							: ({ type: "complete", reason: "stop" } as const),
				}
			: {}),
		createdAt: new Date(m.at),
		metadata: { custom: {} },
	};
}

/**
 * The workbench server owns thread state, persistence, and concurrency —
 * the frontend is a thin external-store rendering layer over it.
 */
export function useChatRuntimeAdapter() {
	const [speech] = useState(() => new WebSpeechSynthesisAdapter());
	const messages = useActiveMessages();
	const runningThreadId = useChatStore((s) => s.runningThreadId);
	const activeId = useChatStore((s) => s.activeId);
	const threads = useChatStore((s) => s.threads);

	return useExternalStoreRuntime({
		messages,
		isRunning: runningThreadId !== null && runningThreadId === activeId,
		convertMessage: toThreadMessage,
		onNew: async (message) => {
			const text = message.content
				.filter(
					(part): part is { type: "text"; text: string } =>
						part.type === "text",
				)
				.map((part) => part.text)
				.join("");
			await useChatStore.getState().send(text);
		},
		onCancel: async () => useChatStore.getState().cancel(),
		onReload: async () => useChatStore.getState().reload(),
		adapters: {
			// browser-native TTS; enables ActionBarPrimitive.Speak/StopSpeaking
			speech,
			feedback: {
				submit: (feedback: {
					message: ThreadMessage;
					type: "positive" | "negative";
				}) => {
					void useChatStore
						.getState()
						.feedback(feedback.message.id, feedback.type);
				},
			},
			threadList: {
				threadId: activeId ?? undefined,
				threads: threads
					.filter((t) => !t.archived)
					.map((t) => ({
						status: "regular" as const,
						id: t.id,
						title: t.title,
					})),
				archivedThreads: threads
					.filter((t) => t.archived)
					.map((t) => ({
						status: "archived" as const,
						id: t.id,
						title: t.title,
					})),
				onSwitchToNewThread: () => useChatStore.getState().createThread(),
				onSwitchToThread: (id: string) =>
					useChatStore.getState().switchThread(id),
				onRename: (id: string, title: string) =>
					useChatStore.getState().renameThread(id, title),
				onArchive: (id: string) =>
					useChatStore.getState().setArchived(id, true),
				onUnarchive: (id: string) =>
					useChatStore.getState().setArchived(id, false),
				onDelete: (id: string) => useChatStore.getState().deleteThread(id),
			},
		},
	});
}
