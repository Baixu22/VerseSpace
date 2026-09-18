import { describe, expect, it } from "bun:test";
import type { ChatRunEvent } from "../../../../apps/workbench-ui/src/chat/message-types";
import type { RunEvent } from "./thread-types";

const serverToClient = (event: RunEvent): ChatRunEvent => event;
const clientToServer = (event: ChatRunEvent): RunEvent => event;

describe("chat NDJSON protocol mirror", () => {
	it("keeps both event unions assignable and preserves pre-turn errors", () => {
		const events: RunEvent[] = [
			{ type: "delta", messageId: "m", text: "tail" },
			{ type: "parts", messageId: "m", parts: [] },
			{
				type: "done",
				messageId: "m",
				message: {
					id: "m",
					role: "assistant",
					text: "tail",
					at: "2026-09-18T00:00:00Z",
				},
			},
			{ type: "error", message: "pre-turn failure" },
			{ type: "turn_started", messageId: "m" },
			{ type: "notice_delivered", messageId: "m", count: 1 },
			{
				type: "user",
				message: {
					id: "u",
					role: "user",
					text: "prompt",
					at: "2026-09-18T00:00:00Z",
				},
			},
		];
		expect(events.map(serverToClient).map(clientToServer)).toEqual(events);
	});
});
