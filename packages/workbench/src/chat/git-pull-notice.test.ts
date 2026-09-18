import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../git";
import { drainPremiseQueue } from "../runtime/delivery";
import { reconcilePremises } from "../runtime/premises";
import { makeCommittedRepo } from "../test/git-project";
import { ChatThreads } from "./threads";

test("真实 git pull 改变 agent 已读文件，通知经 stdin 送达仍存活的会话", async () => {
	const ws = await makeCommittedRepo();
	const sourceRoot = await mkdtemp(join(tmpdir(), "workbench-pull-source-"));
	const upstream = join(sourceRoot, "upstream");
	const previous = process.env.WORKBENCH_CHAT_COMMAND;
	const actor = join(ws.projectDir, "read-agent.ts");
	const runGit = async (cwd: string, args: string[]) => {
		const result = await git(
			["-c", "user.email=t@local", "-c", "user.name=t", ...args],
			cwd,
		);
		if (!result.ok) throw new Error(result.stderr);
	};
	await writeFile(
		actor,
		`
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const emit = (event) => console.log(JSON.stringify(event));
emit({ type: "system", subtype: "init" });
let turn = 0;
for await (const line of createInterface({ input: process.stdin })) {
  appendFileSync("received.jsonl", line + "\\n");
  const id = "read-" + (++turn);
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: process.cwd() + "/README.md" } }] } });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: readFileSync("README.md", "utf8") }] } });
  emit({ type: "result", subtype: "success", result: "已读取" });
  if (turn === 2) { process.stdin.destroy(); break; }
}
`,
	);
	process.env.WORKBENCH_CHAT_COMMAND = `"${process.execPath}" "${actor}"`;
	const chat = new ChatThreads(ws.bb);
	const thread = await chat.create("观察 git pull");
	try {
		await chat.run(thread.id, "读取 README", () => {});
		expect([
			...(await ws.bb.sessions.readSetView(thread.id)).reads.keys(),
		]).toContain("README.md");
		await runGit(sourceRoot, [
			"clone",
			"--no-hardlinks",
			ws.projectDir,
			upstream,
		]);
		await writeFile(join(upstream, "README.md"), "# updated by upstream\n");
		await runGit(upstream, ["commit", "-am", "upstream change"]);
		await runGit(ws.projectDir, ["pull", "--ff-only", upstream, "main"]);
		await reconcilePremises(ws.bb);
		expect(await ws.bb.events.query({ type: "premise_stale" })).toHaveLength(1);
		await drainPremiseQueue(ws.bb, {
			deliver: (writer, message, noticeId) =>
				chat.notifySession(writer, message, noticeId),
		});
		const visible: unknown[] = [];
		await chat.run(thread.id, "继续读取", (event) => {
			visible.push(event);
		});
		expect(
			await readFile(join(ws.projectDir, "received.jsonl"), "utf8"),
		).toContain("前提失效");
		// TF-0207: 每条回合内事件都带本回合预分配的消息 id
		expect(visible).toContainEqual({
			type: "notice_delivered",
			count: 1,
			messageId: expect.any(String),
		});
		expect(
			await ws.bb.events.query({ type: "premise_notice_delivered" }),
		).toHaveLength(1);
	} finally {
		await chat.cancel(thread.id);
		if (previous === undefined) delete process.env.WORKBENCH_CHAT_COMMAND;
		else process.env.WORKBENCH_CHAT_COMMAND = previous;
		await ws.cleanup();
		await rm(sourceRoot, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 250,
		});
	}
});
