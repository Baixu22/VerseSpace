import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
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

/**
 * A fake app-server that dies on the first turn instead of answering it — the
 * "codex crashed mid-turn" case. Nothing will ever send `turn/completed`, so the
 * turn must be settled by the process exit itself.
 */
const FAKE_DYING_APP_SERVER = String.raw`
import { createInterface } from "node:readline";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") { send({ id: msg.id, result: { ok: true } }); continue; }
  if (msg.method === "initialized") continue;
  if (msg.method === "thread/start") { send({ id: msg.id, result: { thread: { id: "thread_fake_dying" } } }); continue; }
  if (msg.method === "turn/start") { process.exit(0); }
}
`;

test("回合中进程死亡：回合以 error 收尾、线程回 idle，而不是永久悬挂", async () => {
	const ws = await makeTempWorkbench();
	const previous = process.env.WORKBENCH_CODEX_COMMAND;
	const chat = new ChatThreads(ws.bb);
	let threadId: string | undefined;
	try {
		const script = join(ws.projectDir, "fake-codex-dying.mjs");
		await writeFile(script, FAKE_DYING_APP_SERVER);
		process.env.WORKBENCH_CODEX_COMMAND = `"${process.execPath}" "${script}"`;
		await ws.bb.config.save({ project: "", chat: { provider: "codex" } });

		const thread = await chat.create();
		threadId = thread.id;
		const events: RunEvent[] = [];
		// The old shape left this promise pending forever (enqueue lock held), so
		// race it: a regression fails in 8s with a readable verdict, not a timeout.
		const settled = await Promise.race([
			chat
				.run(thread.id, "hello", (event) => {
					events.push(structuredClone(event));
				})
				.then(() => "settled" as const),
			new Promise<"hung">((resolve) =>
				setTimeout(() => resolve("hung"), 8_000),
			),
		]);

		expect(settled).toBe("settled");
		expect(events.some((event) => event.type === "error")).toBe(true);
		expect((await chat.get(thread.id)).status).toBe("idle");
	} finally {
		if (threadId) chat.cancel(threadId);
		if (previous === undefined) delete process.env.WORKBENCH_CODEX_COMMAND;
		else process.env.WORKBENCH_CODEX_COMMAND = previous;
		await ws.cleanup();
	}
});

/**
 * A fake app-server that records the prompt it was handed and answers every
 * turn. The first turn answers immediately; later turns stall past a short
 * idle-close window so the timer race is observable.
 */
const FAKE_RECORDING_APP_SERVER = String.raw`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ method, ...(params ? { params } : {}) });
const threadId = "thread_fake_recording";
let turn = 0;
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") { send({ id: msg.id, result: { ok: true } }); continue; }
  if (msg.method === "initialized") continue;
  if (msg.method === "thread/start") { send({ id: msg.id, result: { thread: { id: threadId } } }); continue; }
  if (msg.method === "turn/start") {
    turn += 1;
    const n = turn;
    const input = (msg.params && msg.params.input && msg.params.input[0] && msg.params.input[0].text) || "";
    appendFileSync("codex-prompts.jsonl", JSON.stringify(input) + "\n");
    const delay = n === 1 ? 0 : 3600;
    setTimeout(() => {
      notify("turn/started", { threadId, turn: { id: "turn_" + n } });
      notify("item/started", { threadId, turnId: "turn_" + n, item: { type: "agentMessage", id: "msg_" + n, text: "", phase: "final_answer" } });
      notify("item/agentMessage/delta", { threadId, turnId: "turn_" + n, itemId: "msg_" + n, delta: "answer " + n });
      notify("item/completed", { threadId, turnId: "turn_" + n, item: { type: "agentMessage", id: "msg_" + n, text: "answer " + n, phase: "final_answer" } });
      notify("turn/completed", { threadId, turn: { id: "turn_" + n, status: "completed" } });
      send({ id: msg.id, result: { ok: true } });
    }, delay);
    continue;
  }
}
`;

test("空闲关闭计时器在下一轮被取消：跨过窗口的回合仍能收尾", async () => {
	const ws = await makeTempWorkbench();
	const previousCommand = process.env.WORKBENCH_CODEX_COMMAND;
	const previousIdle = process.env.WORKBENCH_SESSION_IDLE_MS;
	const chat = new ChatThreads(ws.bb);
	let threadId: string | undefined;
	try {
		const script = join(ws.projectDir, "fake-codex-recording.mjs");
		await writeFile(script, FAKE_RECORDING_APP_SERVER);
		process.env.WORKBENCH_CODEX_COMMAND = `"${process.execPath}" "${script}"`;
		// Windows chosen with slack for a loaded CI box (the workbench suite also
		// runs on a 16 GB host): the gap before turn 2 starts must stay well
		// under the idle window, and turn 2 must still outlive it 3×.
		process.env.WORKBENCH_SESSION_IDLE_MS = "1200";
		await ws.bb.config.save({ project: "", chat: { provider: "codex" } });

		const thread = await chat.create();
		threadId = thread.id;
		await chat.run(thread.id, "first", () => {});

		const events: RunEvent[] = [];
		const settled = await Promise.race([
			chat
				.run(thread.id, "second", (event) => {
					events.push(structuredClone(event));
				})
				.then(() => "settled" as const),
			new Promise<"hung">((resolve) =>
				setTimeout(() => resolve("hung"), 8_000),
			),
		]);

		expect(settled).toBe("settled");
		// The idle timer must not have killed the app-server mid-turn.
		expect(events.some((event) => event.type === "error")).toBe(false);
		const done = events.find((event) => event.type === "done");
		expect(done && done.type === "done" && done.message.text).toBe("answer 2");
	} finally {
		if (threadId) chat.cancel(threadId);
		if (previousCommand === undefined)
			delete process.env.WORKBENCH_CODEX_COMMAND;
		else process.env.WORKBENCH_CODEX_COMMAND = previousCommand;
		if (previousIdle === undefined)
			delete process.env.WORKBENCH_SESSION_IDLE_MS;
		else process.env.WORKBENCH_SESSION_IDLE_MS = previousIdle;
		await ws.cleanup();
	}
});

test("前提通知按共享口径折入 codex prompt，而不是裸拼接", async () => {
	const ws = await makeTempWorkbench();
	const previous = process.env.WORKBENCH_CODEX_COMMAND;
	const chat = new ChatThreads(ws.bb);
	let threadId: string | undefined;
	try {
		const script = join(ws.projectDir, "fake-codex-recording.mjs");
		await writeFile(script, FAKE_RECORDING_APP_SERVER);
		process.env.WORKBENCH_CODEX_COMMAND = `"${process.execPath}" "${script}"`;
		await ws.bb.config.save({ project: "", chat: { provider: "codex" } });

		const thread = await chat.create();
		threadId = thread.id;
		expect(
			await chat.notifySession(thread.id, "packages/x.ts 的前提已失效"),
		).toBe("queued");
		await chat.run(thread.id, "继续", () => {});

		const prompts = (
			await readFile(join(ws.projectDir, "codex-prompts.jsonl"), "utf8")
		)
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as string);
		expect(prompts).toHaveLength(1);
		// Same framing the claude lane sends: without it the notice text reads as
		// if it were the user's request.
		expect(prompts[0]).toContain("[Workbench 前提通知");
		expect(prompts[0]).toContain("packages/x.ts 的前提已失效");
		expect(prompts[0]).toContain("[当前用户请求]");
		expect(prompts[0]).toContain("继续");
	} finally {
		if (threadId) chat.cancel(threadId);
		if (previous === undefined) delete process.env.WORKBENCH_CODEX_COMMAND;
		else process.env.WORKBENCH_CODEX_COMMAND = previous;
		await ws.cleanup();
	}
});

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/**
 * A fake app-server that spawns, reads stdin and never answers anything — the
 * "alive but mute" case. No frame can settle the lane's promises, so only the
 * silence watch can end the turn.
 */
const FAKE_MUTE_APP_SERVER = `
import { createInterface } from "node:readline";
for await (const _line of createInterface({ input: process.stdin })) {
  // deliberately mute: no handshake, no turn, no exit
}
`;

/** A fake app-server that dies before the handshake completes. */
const FAKE_DEAD_ON_START_APP_SERVER = `
process.exit(1);
`;

/**
 * A fake app-server that compacts the thread in the middle of a turn. The gap
 * after the compaction is real time on purpose: if compaction ended the turn,
 * the router would already be detached when the answer arrives.
 */
const FAKE_COMPACTING_APP_SERVER = String.raw`
import { createInterface } from "node:readline";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ method, ...(params ? { params } : {}) });
const threadId = "thread_fake_compacting";
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const msg = JSON.parse(line);
  if (msg.method === "initialize") { send({ id: msg.id, result: { ok: true } }); continue; }
  if (msg.method === "initialized") continue;
  if (msg.method === "thread/start") { send({ id: msg.id, result: { thread: { id: threadId } } }); continue; }
  if (msg.method === "turn/start") {
    notify("turn/started", { threadId, turn: { id: "turn_1" } });
    notify("item/started", { threadId, turnId: "turn_1", item: { type: "agentMessage", id: "msg_1", text: "", phase: "final_answer" } });
    notify("item/agentMessage/delta", { threadId, turnId: "turn_1", itemId: "msg_1", delta: "before " });
    notify("thread/compacted", { threadId });
    setTimeout(() => {
      notify("item/agentMessage/delta", { threadId, turnId: "turn_1", itemId: "msg_1", delta: "after" });
      notify("item/completed", { threadId, turnId: "turn_1", item: { type: "agentMessage", id: "msg_1", text: "before after", phase: "final_answer" } });
      notify("turn/completed", { threadId, turn: { id: "turn_1", status: "completed" } });
      send({ id: msg.id, result: { ok: true } });
    }, 300);
    continue;
  }
}
`;

test("静默的 app-server 被判死：回合以 error 收尾，而不是永久悬挂", async () => {
	const ws = await makeTempWorkbench();
	const prevCommand = process.env.WORKBENCH_CODEX_COMMAND;
	const prevStall = process.env.WORKBENCH_LIVENESS_STALL_MS;
	const prevUnresponsive = process.env.WORKBENCH_LIVENESS_UNRESPONSIVE_MS;
	const prevGrace = process.env.WORKBENCH_LIVENESS_KILL_GRACE_MS;
	const chat = new ChatThreads(ws.bb);
	let threadId: string | undefined;
	try {
		const script = join(ws.projectDir, "fake-codex-mute.mjs");
		await writeFile(script, FAKE_MUTE_APP_SERVER);
		process.env.WORKBENCH_CODEX_COMMAND = `"${process.execPath}" "${script}"`;
		// Short windows: the point is the escalation, not the default 135s.
		process.env.WORKBENCH_LIVENESS_STALL_MS = "200";
		process.env.WORKBENCH_LIVENESS_UNRESPONSIVE_MS = "500";
		process.env.WORKBENCH_LIVENESS_KILL_GRACE_MS = "50";
		await ws.bb.config.save({ project: "", chat: { provider: "codex" } });

		const thread = await chat.create();
		threadId = thread.id;
		const events: RunEvent[] = [];
		const settled = await Promise.race([
			chat
				.run(thread.id, "hello", (event) => {
					events.push(structuredClone(event));
				})
				.then(() => "settled" as const),
			new Promise<"hung">((resolve) =>
				setTimeout(() => resolve("hung"), 8_000),
			),
		]);

		expect(settled).toBe("settled");
		const error = events.find((event) => event.type === "error");
		expect(error && error.type === "error" && error.message).toContain(
			"无响应",
		);
		expect((await chat.get(thread.id)).status).toBe("idle");
	} finally {
		if (threadId) chat.cancel(threadId);
		restoreEnv("WORKBENCH_CODEX_COMMAND", prevCommand);
		restoreEnv("WORKBENCH_LIVENESS_STALL_MS", prevStall);
		restoreEnv("WORKBENCH_LIVENESS_UNRESPONSIVE_MS", prevUnresponsive);
		restoreEnv("WORKBENCH_LIVENESS_KILL_GRACE_MS", prevGrace);
		await ws.cleanup();
	}
});

test("握手失败不留残骸：线程回 idle，后续回合仍能收尾而不是卡在 running", async () => {
	const ws = await makeTempWorkbench();
	const prevCommand = process.env.WORKBENCH_CODEX_COMMAND;
	const chat = new ChatThreads(ws.bb);
	let threadId: string | undefined;
	try {
		const script = join(ws.projectDir, "fake-codex-dead.mjs");
		await writeFile(script, FAKE_DEAD_ON_START_APP_SERVER);
		process.env.WORKBENCH_CODEX_COMMAND = `"${process.execPath}" "${script}"`;
		await ws.bb.config.save({ project: "", chat: { provider: "codex" } });

		const thread = await chat.create();
		threadId = thread.id;
		const runTurn = async (label: string) => {
			const events: RunEvent[] = [];
			const settled = await Promise.race([
				chat
					.run(thread.id, label, (event) => {
						events.push(structuredClone(event));
					})
					.then(() => "settled" as const),
				new Promise<"hung">((resolve) =>
					setTimeout(() => resolve("hung"), 8_000),
				),
			]);
			return { settled, events };
		};

		const first = await runTurn("first");
		expect(first.settled).toBe("settled");
		expect(first.events.some((event) => event.type === "error")).toBe(true);
		expect((await chat.get(thread.id)).status).toBe("idle");

		// The regression: a corpse left in `liveCodex` made every later turn
		// return early without resetting the status. The message is the tell —
		// "线程未能建立" means the stale session was reused instead of retried,
		// so the second turn must report the real transport failure instead.
		const second = await runTurn("second");
		expect(second.settled).toBe("settled");
		const secondError = second.events.find((event) => event.type === "error");
		expect(
			secondError && secondError.type === "error" && secondError.message,
		).toContain("codex app-server");
		expect((await chat.get(thread.id)).status).toBe("idle");
	} finally {
		if (threadId) chat.cancel(threadId);
		restoreEnv("WORKBENCH_CODEX_COMMAND", prevCommand);
		await ws.cleanup();
	}
});

test("回合中压缩不终结回合：压缩之后的正文仍然落库", async () => {
	const ws = await makeTempWorkbench();
	const prevCommand = process.env.WORKBENCH_CODEX_COMMAND;
	const chat = new ChatThreads(ws.bb);
	let threadId: string | undefined;
	try {
		const script = join(ws.projectDir, "fake-codex-compacting.mjs");
		await writeFile(script, FAKE_COMPACTING_APP_SERVER);
		process.env.WORKBENCH_CODEX_COMMAND = `"${process.execPath}" "${script}"`;
		await ws.bb.config.save({ project: "", chat: { provider: "codex" } });

		const thread = await chat.create();
		threadId = thread.id;
		const events: RunEvent[] = [];
		await chat.run(thread.id, "hello", (event) => {
			events.push(structuredClone(event));
		});

		const done = events.find((event) => event.type === "done");
		expect(done && done.type === "done" && done.message.text).toBe(
			"before after",
		);
		expect(events.some((event) => event.type === "error")).toBe(false);
		expect((await chat.get(thread.id)).status).toBe("idle");
	} finally {
		if (threadId) chat.cancel(threadId);
		restoreEnv("WORKBENCH_CODEX_COMMAND", prevCommand);
		await ws.cleanup();
	}
});
