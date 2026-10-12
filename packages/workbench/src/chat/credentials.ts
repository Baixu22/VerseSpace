import type { WorkbenchConfig } from "../types/config";
import { capabilitiesOf } from "./provider-capabilities";

type ChatConfig = WorkbenchConfig["chat"];
type FallbackTarget = NonNullable<ChatConfig["fallbacks"]>[number];

/** Resolve at request time; environment credentials never enter saved config. */
export function chatApiKey(chat: ChatConfig): string {
	return chat.apiKey || process.env.WORKBENCH_CHAT_API_KEY || "";
}

/**
 * Credential for a fallback target. A target's own key always wins. Only a
 * target on the *same* provider may reuse the primary key: the environment
 * credential belongs to the primary vendor and must never be sent to another
 * vendor's endpoint.
 */
export function fallbackApiKey(
	chat: ChatConfig,
	target: FallbackTarget,
): string {
	if (target.apiKey) return target.apiKey;
	if (target.provider === chat.provider) return chatApiKey(chat);
	return "";
}

export function publicChatConfig(chat: ChatConfig) {
	const { apiKey: _secret, fallbacks, ...rest } = chat;
	return {
		...rest,
		hasKey: Boolean(chatApiKey(chat)),
		// Fallback targets are returned without their secrets, like the primary.
		fallbacks: fallbacks?.map(({ apiKey, ...target }) => ({
			...target,
			hasKey: Boolean(apiKey),
		})),
		// TF-0204: the UI reads what this provider can do from the single
		// capabilities table instead of re-deriving it from the provider name.
		capabilities: capabilitiesOf(chat.provider),
	};
}
