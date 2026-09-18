import type { WorkbenchConfig } from "../types/config";
import { capabilitiesOf } from "./provider-capabilities";

/** Resolve at request time; environment credentials never enter saved config. */
export function chatApiKey(chat: WorkbenchConfig["chat"]): string {
	return chat.apiKey || process.env.WORKBENCH_CHAT_API_KEY || "";
}

export function publicChatConfig(chat: WorkbenchConfig["chat"]) {
	const { apiKey: _secret, ...rest } = chat;
	return {
		...rest,
		hasKey: Boolean(chatApiKey(chat)),
		// TF-0204: the UI reads what this provider can do from the single
		// capabilities table instead of re-deriving it from the provider name.
		capabilities: capabilitiesOf(chat.provider),
	};
}
