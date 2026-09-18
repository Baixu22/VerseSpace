import { expect, test } from "bun:test";
import { ChatThreads, type RunEvent } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import { chatRoute } from "./chat-routes";

test("request errors before a turn starts use the shared error protocol", async () => {
	const ws = await makeTempWorkbench();
	try {
		const chat = new ChatThreads(ws.bb);
		const url = new URL("http://localhost/api/chat/threads/missing/messages");
		const response = await chatRoute(
			ws.bb,
			chat,
			url,
			new Request(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "hello" }),
			}),
		);
		expect(response?.headers.get("content-type")).toBe("application/x-ndjson");
		const events = (await response!.text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as RunEvent);
		expect(events).toEqual([{ type: "error", message: expect.any(String) }]);
		expect(events[0]).not.toHaveProperty("text");
	} finally {
		await ws.cleanup();
	}
});
