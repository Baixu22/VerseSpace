import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathExists } from "../fs/atomic";
import { makeTempWorkbench } from "../test/fixtures";
import { ChatThreads } from "./threads";

test("空通知不进入持久队列，也不创建可被误确认的通知身份", async () => {
	const ws = await makeTempWorkbench();
	try {
		const chat = new ChatThreads(ws.bb);
		const thread = await chat.create();
		expect(await chat.notifySession(thread.id, "", "empty")).toBe(false);
		expect(await chat.notifySession(thread.id, " \n\t", "blank")).toBe(false);
		expect(
			await pathExists(
				join(ws.workbenchRoot, "threads", thread.id, "notices.jsonl"),
			),
		).toBe(false);
	} finally {
		await ws.cleanup();
	}
});
