import type { WorkbenchConfig } from "../types/config";

import { httpEndpoint } from "./http-endpoint";

export function buildHttpRequest(
	provider: WorkbenchConfig["chat"]["provider"],
	key: string,
	chat: WorkbenchConfig["chat"],
	history: Array<{ role: string; content: string }>,
): {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
} {
	let url: string;
	const headers: Record<string, string> = {
		"content-type": "application/json",
	};
	const body: Record<string, unknown> = {};

	if (provider === "anthropic") {
		url = httpEndpoint(
			chat.baseUrl ?? "https://api.anthropic.com",
			"/v1/messages",
		);
		headers["x-api-key"] = key;
		headers["anthropic-version"] = "2023-06-01";
		body.model = chat.model ?? "claude-sonnet-4-5";
		body.max_tokens = chat.maxTokens ?? 1024;
		if (chat.temperature !== undefined) {
			body.temperature = chat.temperature;
		}
		body.stream = true;
		body.messages = history;
	} else if (provider === "openai-chat") {
		url = httpEndpoint(
			chat.baseUrl ?? "https://api.openai.com/v1",
			"/chat/completions",
		);
		headers.authorization = `Bearer ${key}`;
		body.model = chat.model ?? "gpt-4o-mini";
		body.messages = history;
		body.stream = true;
		if (chat.temperature !== undefined) {
			body.temperature = chat.temperature;
		}
		if (chat.maxTokens !== undefined) {
			body.max_tokens = chat.maxTokens;
		}
	} else {
		// openai-responses
		url = httpEndpoint(
			chat.baseUrl ?? "https://api.openai.com/v1",
			"/responses",
		);
		headers.authorization = `Bearer ${key}`;
		body.model = chat.model ?? "gpt-4o-mini";
		body.input = history.map((m) => ({ role: m.role, content: m.content }));
		body.stream = true;
		if (chat.temperature !== undefined) {
			body.temperature = chat.temperature;
		}
		if (chat.maxTokens !== undefined) {
			body.max_output_tokens = chat.maxTokens;
		}
		if (chat.effort) {
			body.reasoning = { effort: chat.effort };
		}
	}
	return { url, headers, body };
}
