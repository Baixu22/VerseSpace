import {
	type ThreadMessage,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import { type StoredMessage, useActiveMessages, useChatStore } from "./store";

function toThreadMessage(m: StoredMessage): ThreadMessage {
	return {
		id: m.id,
		role: m.role === "user" ? "user" : "assistant",
		content: [{ type: "text", text: m.text }],
		status: { type: m.status === "running" ? "running" : "complete" },
		createdAt: new Date(m.at),
		metadata: { custom: {} },
	} as unknown as ThreadMessage;
}

/**
 * The workbench server owns thread state, persistence, and concurrency —
 * the frontend is a thin external-store rendering layer over it.
 */
export function useChatRuntimeAdapter() {
	const messages = useActiveMessages();
	const runningThreadId = useChatStore((s) => s.runningThreadId);
	const activeId = useChatStore((s) => s.activeId);

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
	});
}
