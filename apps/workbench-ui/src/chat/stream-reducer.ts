import type {
	AssistantRunEvent,
	ChatRunEvent,
	MessagePart,
	StoredMessage,
} from "./message-types";

function appendText(message: StoredMessage, text: string): StoredMessage {
	// Text-only history has no parts yet; keep its existing text when the first
	// structured update arrives. Never merge across a tool or collapsed group.
	const parts: MessagePart[] = [
		...(message.parts ??
			(message.text ? [{ type: "text" as const, text: message.text }] : [])),
	];
	const last = parts.at(-1);
	if (last?.type === "text") {
		parts[parts.length - 1] = { ...last, text: last.text + text };
	} else {
		parts.push({ type: "text", text });
	}
	return { ...message, text: message.text + text, parts };
}

/** Apply one assistant NDJSON event; the server owns the ordered parts. */
export function applyAssistantRunEvent(
	message: StoredMessage,
	event: AssistantRunEvent,
): StoredMessage {
	// Only route-level errors may precede turn_started and lack a server id.
	if (event.messageId !== undefined && event.messageId !== message.id) {
		return message;
	}
	switch (event.type) {
		case "delta":
			return event.text ? appendText(message, event.text) : message;
		case "parts":
			return {
				...message,
				parts: event.parts,
				text: event.parts
					.map((part) => (part.type === "text" ? part.text : ""))
					.join(""),
			};
		case "done":
			return { ...event.message, status: "complete" };
		case "error": {
			const separator = message.text || message.parts?.length ? "\n\n" : "";
			return {
				...appendText(message, `${separator}运行出错：${event.message}`),
				status: "complete",
			};
		}
	}
}

export function isAssistantRunEvent(
	event: ChatRunEvent,
): event is AssistantRunEvent {
	return ["delta", "parts", "done", "error"].includes(event.type);
}
