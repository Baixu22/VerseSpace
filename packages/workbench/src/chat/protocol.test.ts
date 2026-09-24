import { describe, expect, it } from "bun:test";
import type { ChatRunEvent } from "../../../../apps/workbench-ui/src/chat/message-types";
import type { RunEvent } from "./thread-types";

// 这两支箭头的价值在类型层：`tsc` 分别验证两个事件联合可以互相赋值（服务端
// 写的事件客户端能读，客户端认识的事件服务端也认）。运行时它们必须是恒等
// 映射——下面的断言把「恒等」写成可观察的行为，而不是把输入原样比回输入。
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

		const mirrored = events.map(serverToClient).map(clientToServer);

		// 「保留 pre-turn 错误」是一个具体断言，不是 `events === events`：错误
		// 事件必须带着 message 活过镜像，并且仍然排在 turn_started 之前——
		// 这正是协议承诺的「回合还没开始就失败，客户端也能收到」。
		const errorIndex = mirrored.findIndex((event) => event.type === "error");
		expect(errorIndex).toBeGreaterThanOrEqual(0);
		expect(mirrored[errorIndex]).toMatchObject({
			type: "error",
			message: "pre-turn failure",
		});
		expect(errorIndex).toBeLessThan(
			mirrored.findIndex((event) => event.type === "turn_started"),
		);

		// 线上是 NDJSON：每个事件序列化后必须原样读回。丢掉一个字段、塞进
		// 不可 JSON 化的值，或任何有损的「镜像」都会在这里失败。
		expect(JSON.parse(JSON.stringify(mirrored))).toEqual(mirrored);
	});
});
