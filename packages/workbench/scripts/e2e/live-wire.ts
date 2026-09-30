import { httpEndpoint } from "../../src/chat/http-endpoint";
import type { LiveMessage, LiveProvider } from "./live-provider";
import { liveTools } from "./live-tools";

export interface LiveCompletion {
	id?: string;
	model?: string;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		cost?: number;
	};
	choices?: Array<{ message?: LiveMessage; finish_reason?: string }>;
}

/** Full Responses endpoints select that wire; ordinary bases keep chat compatibility. */
export function liveProtocol(
	baseUrl: string,
): "openai-chat" | "openai-responses" {
	return new URL(httpEndpoint(baseUrl, "")).pathname.endsWith("/responses")
		? "openai-responses"
		: "openai-chat";
}

export function liveRequest(
	provider: LiveProvider,
	messages: LiveMessage[],
	requireTools: boolean,
) {
	const protocol = liveProtocol(provider.baseUrl);
	const common = {
		model: provider.model,
		temperature: 0,
		stream: false,
		tool_choice: requireTools ? "required" : "auto",
	};
	if (protocol === "openai-chat")
		return {
			protocol,
			url: httpEndpoint(provider.baseUrl, "/chat/completions"),
			body: { ...common, messages, tools: liveTools, max_tokens: 4096 },
		};
	const input = messages.flatMap((message): unknown[] => {
		if (message.role === "tool")
			return [
				{
					type: "function_call_output",
					call_id: message.tool_call_id,
					output: message.content ?? "",
				},
			];
		// Replay provider output items, including reasoning, with their call IDs.
		if (message.role === "assistant" && message.response_output)
			return message.response_output;
		const items: unknown[] = message.content
			? [{ role: message.role, content: message.content }]
			: [];
		for (const call of message.tool_calls ?? [])
			items.push({
				type: "function_call",
				call_id: call.id,
				name: call.function.name,
				arguments: call.function.arguments,
			});
		return items;
	});
	return {
		protocol,
		url: httpEndpoint(provider.baseUrl, "/responses"),
		body: {
			...common,
			input,
			store: false,
			max_output_tokens: 4096,
			tools: liveTools.map((tool) => ({
				type: "function",
				...tool.function,
				strict: false,
			})),
		},
	};
}

/** Normalize only a completed response; partial/failed tool calls must never execute. */
export function liveCompletion(
	raw: unknown,
	protocol: ReturnType<typeof liveProtocol>,
): LiveCompletion {
	if (protocol === "openai-chat") return raw as LiveCompletion;
	const body = raw as {
		id?: string;
		model?: string;
		status?: string;
		error?: unknown;
		output?: unknown[];
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			total_tokens?: number;
		};
	};
	if (body?.status !== "completed" || body.error || !Array.isArray(body.output))
		throw new Error("Responses 回复未完成或结构无效，未执行工具");
	const calls: NonNullable<LiveMessage["tool_calls"]> = [];
	const text: string[] = [];
	for (const value of body.output) {
		if (!value || typeof value !== "object")
			throw new Error("Responses 输出项无效");
		const item = value as Record<string, unknown>;
		if (item.status !== undefined && item.status !== "completed")
			throw new Error("Responses 输出项未完成，未执行工具");
		if (item.type === "function_call") {
			if (
				typeof item.call_id !== "string" ||
				!item.call_id ||
				typeof item.name !== "string" ||
				typeof item.arguments !== "string"
			)
				throw new Error("Responses 工具调用字段无效");
			calls.push({
				id: item.call_id,
				type: "function",
				function: { name: item.name, arguments: item.arguments },
			});
		} else if (item.type === "message") {
			if (item.role !== "assistant" || !Array.isArray(item.content))
				throw new Error("Responses 消息字段无效");
			for (const part of item.content) {
				if (part?.type === "output_text" && typeof part.text === "string")
					text.push(part.text);
				else if (part?.type === "refusal" && typeof part.refusal === "string")
					text.push(part.refusal);
			}
		} else if (item.type !== "reasoning")
			throw new Error("Responses 返回了未支持的输出项");
	}
	return {
		id: body.id,
		model: body.model,
		usage: body.usage && {
			prompt_tokens: body.usage.input_tokens,
			completion_tokens: body.usage.output_tokens,
			total_tokens: body.usage.total_tokens,
		},
		choices: [
			{
				finish_reason: calls.length ? "tool_calls" : "stop",
				message: {
					role: "assistant",
					content: text.join("") || null,
					...(calls.length ? { tool_calls: calls } : {}),
					response_output: body.output,
				},
			},
		],
	};
}
