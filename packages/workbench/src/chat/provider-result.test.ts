import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { ChatThreads, type RunEvent } from "./threads";

test("stream-json errors end the turn as errors, never as successful answers", async () => {
	const ws = await makeTempWorkbench();
	const previous = process.env.WORKBENCH_CHAT_COMMAND;
	const actor = join(ws.projectDir, "failed-agent.ts");
	await writeFile(
		actor,
		`
const emit = (event) => console.log(JSON.stringify(event));
emit({ type: "system", subtype: "init" });
process.stdin.once("data", () => {
  emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "模型没有调用工具" });
  process.stdin.destroy();
});
`,
	);
	process.env.WORKBENCH_CHAT_COMMAND = `"${process.execPath}" "${actor}"`;
	try {
		const chat = new ChatThreads(ws.bb);
		const thread = await chat.create("失败回合");
		await chat.notifySession(thread.id, "前提已变", "notice-test");
		const events: RunEvent[] = [];
		await chat.run(thread.id, "执行任务", (event) => events.push(event));
		expect(events.filter((event) => event.type === "error")).toEqual([
			{ type: "error", message: "模型没有调用工具" },
		]);
		expect(
			events.some((event) => event.type === "done" || event.type === "delta"),
		).toBe(false);
		expect((await chat.get(thread.id)).status).toBe("idle");
		expect(
			(await chat.messages(thread.id)).map((message) => message.role),
		).toEqual(["user"]);
		expect(
			(await ws.bb.events.all()).some(
				(event) => event.type === "premise_notice_delivered",
			),
		).toBe(false);
	} finally {
		if (previous === undefined) delete process.env.WORKBENCH_CHAT_COMMAND;
		else process.env.WORKBENCH_CHAT_COMMAND = previous;
		await ws.cleanup();
	}
});
