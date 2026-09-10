import type { WorkbenchConfig } from "../types/config";

/** Resolve at request time; environment credentials never enter saved config. */
export function chatApiKey(chat: WorkbenchConfig["chat"]): string {
	return chat.apiKey || process.env.WORKBENCH_CHAT_API_KEY || "";
}

export function publicChatConfig(chat: WorkbenchConfig["chat"]) {
	const { apiKey: _secret, ...rest } = chat;
	return { ...rest, hasKey: Boolean(chatApiKey(chat)) };
}
