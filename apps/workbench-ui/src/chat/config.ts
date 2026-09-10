import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "../auth";

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
