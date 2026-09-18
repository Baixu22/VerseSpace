import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "../auth";

/**
 * TF-0204: what the selected provider can actually do, sent by the backend's
 * single capabilities table (`packages/workbench/src/chat/provider-capabilities.ts`).
 * The panel states observability from this, never from the provider name.
 */
export interface ProviderCapabilities {
	channel: "local-cli" | "http";
	observesFootprint: boolean;
	supportsFork: boolean;
	supportsStreamJson: boolean;
	requiresApiKey: boolean;
}

export interface ChatConfig {
	provider: "claude" | "openai-chat" | "openai-responses" | "anthropic";
	model?: string;
	apiKey?: string;
	baseUrl?: string;
	temperature?: number;
	maxTokens?: number;
	/** null clears a previously saved choice when editing the form. */
	effort?: "low" | "medium" | "high" | null;
	hasKey?: boolean;
	/** Absent only when the response is older than the panel; then claim nothing. */
	capabilities?: ProviderCapabilities;
}

export const chatConfigQuery = queryOptions({
	queryKey: ["chat-config"],
	staleTime: 30_000,
	queryFn: async (): Promise<ChatConfig> => {
		const response = await apiFetch("/api/config/chat");
		if (!response.ok) throw new Error("无法读取对话设置，请稍后重试。");
		return response.json();
	},
});
