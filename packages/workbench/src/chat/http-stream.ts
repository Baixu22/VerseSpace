import { codecFor, type HttpProvider } from "./protocols";

export interface SseConsumeResult {
	/** False when EOF arrived with an unterminated SSE frame. */
	complete: boolean;
}

/**
 * A shadow variant: one extra non-streamed-to-user request whose text is kept
 * as an alternate. It uses the same codec as the main request, so it can only
 * ever yield text the protocol actually produced.
 */
export async function runHttpShadow(
	provider: HttpProvider,
	url: string,
	headers: Record<string, string>,
	body: Record<string, unknown>,
	signal: AbortSignal,
): Promise<string> {
	const codec = codecFor(provider);
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
			for (const frame of codec.parse(payload)) {
				if (frame.text) text += frame.text;
			}
		});
		return text;
	} catch {
		return "";
	}
}

export interface ConsumeSseOptions {
	/** Called for every chunk read from the body, including keep-alives. */
	onChunk?: () => void;
}

export async function consumeSse(
	response: Response,
	onSseData: (payload: string) => void,
	options: ConsumeSseOptions = {},
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
		options.onChunk?.();
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
