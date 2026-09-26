/**
 * Capture the REAL approval params codex 0.158 sends (TF-0264 的下一步).
 *
 * ADR-0017 recorded that approval params were never parsed "because no retained
 * fixture documents their shape". `approval-targets.ts` was therefore written
 * against a guessed shape — and the stale/fresh contrast showed the guess missing
 * (0 seal events in the stale run). This probe speaks the app-server protocol
 * itself, records every server→client request verbatim, and answers approvals with
 * accept so the turn can finish.
 *
 * Output is the fixture: what the lane must actually parse.
 *
 * Usage:
 *   WB_CODEX_BIN=<abs codex> CODEX_HOME=<isolated> WB_VERIFY_LLM_KEY=<key> \
 *   bun packages/workbench/scripts/verify/codex-approval-capture.ts --json
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const asJson = process.argv.includes("--json");
const bin = process.env.WB_CODEX_BIN;
if (!bin) {
	console.error("缺 WB_CODEX_BIN（真实 codex 的绝对路径）");
	process.exit(2);
}

const workdir = join(
	process.env.TEMP ?? process.env.TMP ?? ".",
	"wb-codex-capture",
);
await mkdir(join(workdir, "src"), { recursive: true });
await writeFile(
	join(workdir, "src", "target.ts"),
	"export const target = 1;\n",
);

const child = spawn(bin, ["app-server", "-c", "notify=[]"], {
	cwd: workdir,
	env: process.env,
	stdio: ["pipe", "pipe", "pipe"],
});

const captured: Array<{ method: string; params: unknown }> = [];
const notifications: string[] = [];
let nextId = 1;
const pending = new Map<number, (value: unknown) => void>();

function send(message: Record<string, unknown>): void {
	child.stdin.write(`${JSON.stringify(message)}\n`);
}
function request(method: string, params: unknown): Promise<unknown> {
	const id = nextId++;
	return new Promise((resolve) => {
		pending.set(id, resolve);
		send({ id, method, params });
	});
}

let buffer = "";
child.stdout.on("data", (chunk: Buffer) => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\n");
	while (index !== -1) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		index = buffer.indexOf("\n");
		if (!line.trim()) continue;
		let message: {
			id?: number;
			method?: string;
			params?: unknown;
			result?: unknown;
		};
		try {
			message = JSON.parse(line);
		} catch {
			continue;
		}
		if (message.id !== undefined && message.method) {
			// Server-initiated request — THIS is what we came for.
			captured.push({ method: message.method, params: message.params ?? null });
			// Accept so the turn can proceed; the capture is the deliverable.
			send({ id: message.id, result: { decision: "accept" } });
			continue;
		}
		if (message.id !== undefined) {
			pending.get(message.id)?.(message.result);
			pending.delete(message.id);
			continue;
		}
		if (message.method) notifications.push(message.method);
	}
});

const timeout = setTimeout(() => {
	finish("超时（120s）");
}, 120_000);

let finished = false;
function finish(reason: string): void {
	if (finished) return;
	finished = true;
	clearTimeout(timeout);
	child.kill();
	const report = {
		reason,
		workdir,
		captured,
		notifications: [...new Set(notifications)],
	};
	if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	else {
		console.log(`结束：${reason}`);
		console.log(`捕获 ${captured.length} 个 server→client 请求：`);
		for (const entry of captured) {
			console.log(`  ${entry.method}\n    ${JSON.stringify(entry.params)}`);
		}
	}
	process.exit(captured.length > 0 ? 0 : 2);
}

await request("initialize", {
	clientInfo: { name: "workbench", title: "Workbench", version: "0.1.0" },
	capabilities: { experimentalApi: true },
});
send({ method: "initialized" });
const threadResult = (await request("thread/start", { cwd: workdir })) as {
	thread?: { id?: string };
};
const threadId = threadResult?.thread?.id ?? "";
const prompt =
	process.env.WB_VERIFY_PROMPT ??
	"Run exactly this shell command and then report what happened: echo '// probe' >> src/target.ts";
await request("turn/start", {
	threadId,
	input: [
		{
			type: "text",
			text: prompt,
			text_elements: [],
		},
	],
});

// The turn runs in the background; `finish` is driven by the notification stream.
const watcher = setInterval(() => {
	if (notifications.includes("turn/completed")) finish("turn/completed");
}, 500);
watcher.unref?.();
