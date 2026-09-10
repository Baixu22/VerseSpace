import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { foldNoticeOutcomes } from "../runtime/notice-outcome";
import { makeTempWorkbench } from "../test/fixtures";
import { ChatThreads } from "./threads";

test("real process same-turn reread is repaired even though the durable ack comes last", async () => {
	const ws = await makeTempWorkbench();
	const previous = process.env.WORKBENCH_CHAT_COMMAND;
	const actor = join(ws.projectDir, "read-agent.ts");
	await writeFile(join(ws.projectDir, "value.txt"), "current");
	await writeFile(
		actor,
		`
const emit = (event) => console.log(JSON.stringify(event));
emit({ type: "system", subtype: "init" });
process.stdin.once("data", async () => {
  const path = process.cwd() + "/value.txt";
  const content = await Bun.file(path).text();
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "read", name: "Read", input: { file_path: path } }] } });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content }] } });
  const session = process.argv[process.argv.indexOf("--session-id") + 1];
  const footprint = Bun.file(process.cwd() + "/.workbench/blackboard/sessions/" + session + "/footprint.jsonl");
  const deadline = Date.now() + 2000;
  while (!(await footprint.exists()) && Date.now() < deadline) await Bun.sleep(5);
  emit({ type: "result", subtype: "success", result: "已复读" });
  process.stdin.destroy();
});
`,
	);
	process.env.WORKBENCH_CHAT_COMMAND = `"${process.execPath}" "${actor}"`;
	try {
		const chat = new ChatThreads(ws.bb);
		const thread = await chat.create("同轮复读");
		await ws.bb.events.append({
			timestamp: new Date().toISOString(),
			source: "runtime",
			type: "premise_stale",
			payload: {
				writer: thread.id,
				noticeId: "notice",
				stale: [{ path: "value.txt" }],
			},
		});
		await chat.notifySession(thread.id, "value.txt 已变化，请复读", "notice");
		await chat.run(thread.id, "检查变化", () => {});
		const events = await ws.bb.events.all();
		expect(
			events.findIndex((event) => event.type === "footprint"),
		).toBeLessThan(
			events.findIndex((event) => event.type === "premise_notice_delivered"),
		);
		expect(foldNoticeOutcomes(events).agent.repaired).toBe(1);
	} finally {
		if (previous === undefined) delete process.env.WORKBENCH_CHAT_COMMAND;
		else process.env.WORKBENCH_CHAT_COMMAND = previous;
		await ws.cleanup();
	}
});
