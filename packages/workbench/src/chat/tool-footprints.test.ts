import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { ChatThreads } from "./threads";

test("chat records every successful tool in a grouped event and excludes rejected tools", async () => {
	const ws = await makeTempWorkbench();
	const previous = process.env.WORKBENCH_CHAT_COMMAND;
	const chat = new ChatThreads(ws.bb);
	let threadId: string | undefined;
	try {
		await writeFile(join(ws.projectDir, "first.txt"), "first\n");
		await writeFile(join(ws.projectDir, "second.txt"), "second\n");
		const script = join(ws.projectDir, "actor.mjs");
		await writeFile(
			script,
			String.raw`
import { createInterface } from "node:readline";
const emit = (event) => console.log(JSON.stringify(event));
emit({type:"system", subtype:"init", session_id:"capture-test"});
for await (const line of createInterface({input:process.stdin})) {
  if (!line.trim()) continue;
  emit({type:"assistant", message:{content:[
    {type:"tool_use",id:"first",name:"Read",input:{file_path:"first.txt"}},
    {type:"tool_use",id:"second",name:"Read",input:{file_path:"second.txt"}},
    {type:"tool_use",id:"rejected",name:"Write",input:{file_path:"rejected.txt"}}
  ]}});
  emit({type:"user", message:{content:[
    {type:"tool_result",tool_use_id:"first",content:"first\n"},
    {type:"tool_result",tool_use_id:"second",content:"second\n"},
    {type:"tool_result",tool_use_id:"rejected",is_error:true,content:"denied"}
  ]}});
  emit({type:"result",subtype:"success",result:"read two files"});
  break;
}
process.exit(0);
`,
		);
		process.env.WORKBENCH_CHAT_COMMAND = `"${process.execPath}" "${script}"`;
		const thread = await chat.create();
		threadId = thread.id;
		await chat.run(thread.id, "read two files", () => {});
		const footprint = await ws.bb.sessions.footprint(thread.id);
		expect(footprint.map((entry) => entry.activity)).toEqual([
			"first",
			"second",
		]);
		expect(
			footprint.flatMap((entry) => entry.used.map((claim) => claim.path)),
		).toEqual(["first.txt", "second.txt"]);
		expect(footprint.flatMap((entry) => entry.generated)).toEqual([]);
	} finally {
		if (threadId) await chat.cancel(threadId);
		if (previous === undefined) delete process.env.WORKBENCH_CHAT_COMMAND;
		else process.env.WORKBENCH_CHAT_COMMAND = previous;
		await ws.cleanup();
	}
});
