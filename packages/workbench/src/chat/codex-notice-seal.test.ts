import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { pathExists } from "../fs/atomic";
import { drainPremiseQueue } from "../runtime/delivery";
import { reconcilePremises } from "../runtime/premises";
import { makeTempWorkbench } from "../test/fixtures";
import { ChatThreads } from "./threads";

// A real child process, with controlled provider terminal states and approvals.
const server = `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const send = (msg) => console.log(JSON.stringify(msg));
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: {} });
  if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "t" } } });
  if (msg.method === "turn/start") {
    const mode = msg.params.input[0].text;
    send({ id: msg.id, result: {} });
    if (mode.includes("provider-error")) {
      send({ method: "error", params: { error: { message: "intentional provider error" } } });
    } else if (mode.includes("approve-write")) {
      send({ method: "item/started", params: { threadId: "t", turnId: "turn", item: {
        type: "fileChange", id: "item", changes: [{ path: "target.txt" }], status: "inProgress"
      } } });
      send({ id: 900, method: "item/fileChange/requestApproval", params: { threadId: "t", turnId: "turn", itemId: "item" } });
    } else {
      const status = mode.includes("failed-turn") ? "failed" : mode.includes("interrupted-turn") ? "interrupted" : "completed";
      send({ method: "turn/completed", params: { threadId: "t", turn: { id: "turn", status } } });
    }
  }
  if (msg.id === 900 && !msg.method) {
    writeFileSync("decision.json", JSON.stringify(msg.result));
    send({ method: "turn/completed", params: { threadId: "t", turn: { id: "turn", status: "completed" } } });
  }
}
`;

for (const outcome of [
	"provider-error",
	"failed-turn",
	"interrupted-turn",
	"success",
]) {
	test(`Codex notice acknowledgement follows terminal outcome: ${outcome}`, async () => {
		const ws = await makeTempWorkbench();
		const previous = process.env.WORKBENCH_CODEX_COMMAND;
		const chat = new ChatThreads(ws.bb);
		const thread = await chat.create();
		try {
			const script = join(ws.projectDir, "server.mjs");
			await writeFile(script, server);
			process.env.WORKBENCH_CODEX_COMMAND = `"${process.execPath}" "${script}"`;
			await ws.bb.config.save({ project: "", chat: { provider: "codex" } });
			await chat.notifySession(thread.id, "target.txt changed", "notice-1");
			await chat.run(thread.id, outcome, () => {});
			const queue = join(
				ws.workbenchRoot,
				"threads",
				thread.id,
				"notices.jsonl",
			);
			expect(
				await ws.bb.events.query({ type: "premise_notice_delivered" }),
			).toHaveLength(outcome === "success" ? 1 : 0);
			expect(await pathExists(queue)).toBe(outcome !== "success");
			if (outcome !== "success") {
				expect(await readFile(queue, "utf8")).toContain("notice-1");
				await chat.run(thread.id, "retry-success", () => {});
				expect(
					await ws.bb.events.query({ type: "premise_notice_delivered" }),
				).toHaveLength(1);
				expect(await pathExists(queue)).toBe(false);
			}
		} finally {
			chat.cancel(thread.id);
			if (previous === undefined) delete process.env.WORKBENCH_CODEX_COMMAND;
			else process.env.WORKBENCH_CODEX_COMMAND = previous;
			await ws.cleanup();
		}
	}, 20_000);
}

test("Codex seals its current inputs after delivery and releases after reread", async () => {
	const ws = await makeTempWorkbench();
	const previous = process.env.WORKBENCH_CODEX_COMMAND;
	const chat = new ChatThreads(ws.bb);
	const thread = await chat.create();
	try {
		const script = join(ws.projectDir, "server.mjs");
		await writeFile(script, server);
		process.env.WORKBENCH_CODEX_COMMAND = `"${process.execPath}" "${script}"`;
		await ws.bb.config.save({ project: "", chat: { provider: "codex" } });
		await writeFile(join(ws.projectDir, "target.txt"), "fresh");
		for (const writer of ["other-writer", thread.id]) {
			await ws.bb.sessions.register(writer, "agent");
			await ws.bb.sessions.recordActivity(writer, {
				activity: "read-old",
				agent: writer,
				used: [{ path: "target.txt", version: "old" }],
				generated: [],
				facets: { tool: "Read" },
			});
			await reconcilePremises(ws.bb);
			await drainPremiseQueue(ws.bb, { deliver: async () => true });
			await chat.run(thread.id, "approve-write", () => {});
			const decision = JSON.parse(
				await readFile(join(ws.projectDir, "decision.json"), "utf8"),
			);
			expect(decision.decision).toBe(
				writer === thread.id ? "cancel" : "accept",
			);
		}
		await ws.bb.sessions.recordActivity(thread.id, {
			activity: "reread",
			agent: thread.id,
			used: [await hashPathClaim(ws.projectDir, "target.txt")],
			generated: [],
			facets: { tool: "Read" },
		});
		await chat.run(thread.id, "approve-write", () => {});
		expect(
			JSON.parse(await readFile(join(ws.projectDir, "decision.json"), "utf8"))
				.decision,
		).toBe("accept");
		const decisions = await ws.bb.events.query({ type: "seal.decided" });
		expect(
			decisions.map(
				(event) => (event.payload as { decision: string }).decision,
			),
		).toEqual(["pass", "block", "pass"]);
	} finally {
		chat.cancel(thread.id);
		if (previous === undefined) delete process.env.WORKBENCH_CODEX_COMMAND;
		else process.env.WORKBENCH_CODEX_COMMAND = previous;
		await ws.cleanup();
	}
}, 20_000);
