import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { ChatThreads, type RunEvent } from "./threads";

/**
 * TF-0249: drive the codex lane end-to-end against a FAKE `codex app-server`
 * that speaks the real JSON-RPC-over-stdio protocol (initialize → thread/start →
 * turn/start → notifications → turn/completed). Asserts the three things that
 * matter: a command footprint reaches the ledger, the turn finalizes with the
 * assistant text, and the thread returns to idle.
 *
 * The fake server is a bun script so it runs the same way on every platform.
 */
const FAKE_APP_SERVER = String.raw`
import { createInterface } from "node:readline";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ method, ...(params ? { params } : {}) });
let threadId = "thread_fake_1";
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") { send({ id: msg.id, result: { ok: true } }); continue; }
  if (msg.method === "initialized") continue;
  if (msg.method === "thread/start") { send({ id: msg.id, result: { thread: { id: threadId } } }); continue; }
  if (msg.method === "turn/start") {
    // A turn that reads a file via a shell command, then answers.
    notify("turn/started", { threadId, turn: { id: "turn_1" } });
    notify("item/started", { threadId, turnId: "turn_1", item: {
      type: "commandExecution", id: "call_1", command: "/bin/sh -c 'cat target.txt'",
      commandActions: [{ type: "read", command: "cat target.txt", path: "target.txt" }],
      status: "inProgress",
    }});
    notify("item/completed", { threadId, turnId: "turn_1", item: {
      type: "commandExecution", id: "call_1", command: "/bin/sh -c 'cat target.txt'",
      commandActions: [{ type: "read", command: "cat target.txt", path: "target.txt" }],
      aggregatedOutput: "hello\n", exitCode: 0, status: "completed",
    }});
    notify("item/started", { threadId, turnId: "turn_1", item: { type: "agentMessage", id: "msg_1", text: "", phase: "final_answer" }});
    notify("item/agentMessage/delta", { threadId, turnId: "turn_1", itemId: "msg_1", delta: "Read " });
    notify("item/agentMessage/delta", { threadId, turnId: "turn_1", itemId: "msg_1", delta: "target.txt." });
    notify("item/completed", { threadId, turnId: "turn_1", item: { type: "agentMessage", id: "msg_1", text: "Read target.txt.", phase: "final_answer" }});
    notify("turn/completed", { threadId, turn: { id: "turn_1", status: "completed" } });
    send({ id: msg.id, result: { ok: true } });
    continue;
  }
}
`;

test("codex 车道端到端：命令足迹落账、回合以 done 收尾、线程回 idle", async () => {
	const ws = await makeTempWorkbench();
	const previous = process.env.WORKBENCH_CODEX_COMMAND;
	const chat = new ChatThreads(ws.bb);
	let threadId: string | undefined;
	try {
		await writeFile(join(ws.projectDir, "target.txt"), "hello\n");
		const script = join(ws.projectDir, "fake-codex.mjs");
		await writeFile(script, FAKE_APP_SERVER);
		process.env.WORKBENCH_CODEX_COMMAND = `"${process.execPath}" "${script}"`;
		await ws.bb.config.save({ project: "", chat: { provider: "codex" } });

		const thread = await chat.create();
		threadId = thread.id;
		const events: RunEvent[] = [];
		await chat.run(thread.id, "read the file", (event) => {
			events.push(structuredClone(event));
		});

		// (1) The command's structured read reached the ledger.
		const footprint = await ws.bb.sessions.footprint(thread.id);
		expect(footprint.map((entry) => entry.activity)).toContain("call_1");
		expect(
			footprint.flatMap((entry) => entry.used.map((claim) => claim.path)),
		).toContain("target.txt");

		// (2) The turn finalized with the assistant text.
		const done = events.find((event) => event.type === "done");
		expect(done && done.type === "done" && done.message.text).toBe(
			"Read target.txt.",
		);
		expect(events.some((event) => event.type === "error")).toBe(false);

		// (3) The thread is idle again.
		expect((await chat.get(thread.id)).status).toBe("idle");
		// The codex thread id was recorded for a later resume.
		expect((await chat.get(thread.id)).codexSessionId).toBe("thread_fake_1");
	} finally {
		// The codex process is idle-closed on a 5-minute timer, but the test tears
		// the workspace down now — cancel tree-kills it (its ProcHandle lives in
		// context.running) so the temp dir is not held open on Windows.
		if (threadId) chat.cancel(threadId);
		if (previous === undefined) delete process.env.WORKBENCH_CODEX_COMMAND;
		else process.env.WORKBENCH_CODEX_COMMAND = previous;
		await ws.cleanup();
	}
});
