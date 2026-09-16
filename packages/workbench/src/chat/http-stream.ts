import type { WorkbenchConfig } from "../types/config";

export interface SseConsumeResult {
	/** False when EOF arrived with an unterminated SSE frame. */
	complete: boolean;
}

export async function runHttpShadow(
	provider: WorkbenchConfig["chat"]["provider"],
	url: string,
	headers: Record<string, string>,
	body: Record<string, unknown>,
	signal: AbortSignal,
): Promise<string> {
	try {
		let text = "";
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});
		if (!response.ok || !response.body) {
			return "";
		}
		await consumeSse(response, (payload) => {
			if (payload === "[DONE]") {
				return;
			}
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(payload) as Record<string, unknown>;
			} catch {
				return;
			}
			let delta: string | undefined;
			if (provider === "anthropic") {
				if (event.type === "content_block_delta") {
					const d = event.delta as { type?: string; text?: string } | undefined;
					if (d?.type === "text_delta" && d.text) {
						delta = d.text;
					}
				}
			} else if (provider === "openai-chat") {
				const choices = event.choices as
					| Array<{ delta?: { content?: string } }>
					| undefined;
				delta = choices?.[0]?.delta?.content;
			} else {
				// openai-responses
				if (event.type === "response.output_text.delta") {
					delta = event.delta as string;
				}
			}
			if (delta) {
				text += delta;
			}
		});
		return text;
	} catch {
		return "";
	}
}

export async function consumeSse(
	response: Response,
	onSseData: (payload: string) => void,
): Promise<SseConsumeResult> {
	const reader = response.body!.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let complete = true;
	const dispatch = (chunk: string): void => {
		for (const line of chunk.split(/\r?\n/)) {
			if (line.startsWith("data:")) {
				onSseData(line.slice(5).trim());
			}
		}
	};
	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		const chunks = buffer.split(/\r?\n\r?\n/);
		buffer = chunks.pop() ?? "";
		for (const chunk of chunks) {
			dispatch(chunk);
		}
	}
	buffer += decoder.decode();
	if (buffer.trim()) {
		// A final frame without the SSE blank-line delimiter may still contain
		// useful partial text, so feed it to the renderer but mark the stream
		// incomplete. Callers must not acknowledge durable notices in this case.
		complete = false;
		dispatch(buffer);
	}
	return { complete };
}
