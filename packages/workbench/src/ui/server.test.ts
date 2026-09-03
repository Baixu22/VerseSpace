import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquirePidLock } from "../fs/lockfile";
import { isProcessAlive } from "../supervisor";
import { makeTempWorkbench, type TempWorkbench } from "../test/fixtures";
import { collectState, createUiServer, resolveUiAssets } from "./server";

describe("collectState", () => {
	test("aggregates blackboard and doctor report", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		try {
			const goal = await ws.bb.goals.add({ title: "面板测试" });
			const state = await collectState(ws.bb);
			expect(state.version).toBe("0.3.0");
			expect(state.goals.map((g) => (g as { id: string }).id)).toEqual([
				goal.id,
			]);
			expect(state.doctor.ok).toBe(true);
			expect(state.events).toEqual([]);
		} finally {
			await ws.cleanup();
		}
	});
});

describe("resolveUiAssets", () => {
	test("explicit dir wins; fallback kinds are all valid", async () => {
		const dir = await mkdtemp(join(tmpdir(), "workbench-ui-"));
		try {
			expect(await resolveUiAssets(dir)).toEqual({
				kind: "disk",
				diskDir: dir,
			});
			// the placeholder manifest is empty; whether the dev dist exists
			// depends on the checkout — any of the three kinds is acceptable
			const resolved = await resolveUiAssets();
			expect(["embedded", "disk", "none"]).toContain(resolved.kind);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("ui server", () => {
	test("serves a disk ui dir with SPA fallback and applies sync via POST", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		const uiDir = await mkdtemp(join(tmpdir(), "workbench-spa-"));
		await mkdir(join(uiDir, "assets"), { recursive: true });
		await writeFile(
			join(uiDir, "index.html"),
			"<!doctype html><html><head><title>Workbench</title></head><body>dashboard</body></html>",
			"utf8",
		);
		await writeFile(
			join(uiDir, "assets", "app.js"),
			"console.log('workbench-ui');",
			"utf8",
		);
		const server = await createUiServer(ws.bb, 0, uiDir);
		try {
			const base = `http://127.0.0.1:${server.port}`;

			const page = await fetch(base).then((r) => r.text());
			expect(page).toContain("dashboard");

			const asset = await fetch(`${base}/assets/app.js`);
			expect(asset.status).toBe(200);
			expect(await asset.text()).toContain("workbench-ui");
			expect(asset.headers.get("content-type")).toContain("javascript");

			// history fallback serves the SPA for client routes
			expect(await fetch(`${base}/some/route`).then((r) => r.text())).toContain(
				"dashboard",
			);

			// auth handshake: bootstrap is the one unauthenticated /api route
			const boot = await fetch(`${base}/api/bootstrap`).then((r) => r.json());
			const token = (boot as { token: string }).token;
			expect(typeof token).toBe("string");
			const auth = { "x-workbench-token": token };

			const goal = await ws.bb.goals.add({ title: "服务端测试" });

			// no token / wrong token → 401 on every /api route, GET included
			expect((await fetch(`${base}/api/state`)).status).toBe(401);
			expect(
				(
					await fetch(`${base}/api/state`, {
						headers: { "x-workbench-token": "nope" },
					})
				).status,
			).toBe(401);
			expect((await fetch(`${base}/api/sync`, { method: "POST" })).status).toBe(
				401,
			);

			const state = await fetch(`${base}/api/state`, { headers: auth });
			expect(state.status).toBe(200);
			// no CORS headers at all: the SPA is same-origin, and cross-origin
			// readability is exactly what we refuse to grant
			expect(state.headers.get("access-control-allow-origin")).toBeNull();
			const body = await state.json();
			expect(body.goals).toHaveLength(1);
			expect(body.goals[0].id).toBe(goal.id);

			const sync = await fetch(`${base}/api/sync`, {
				method: "POST",
				headers: auth,
			}).then((r) => r.json());
			expect(sync.applied).toBeGreaterThanOrEqual(1);

			// single-round semantics: the enqueue lands on the NEXT cycle
			await fetch(`${base}/api/sync`, { method: "POST", headers: auth });
			const after = await fetch(`${base}/api/state`, {
				headers: auth,
			}).then((r) => r.json());
			expect(after.goals[0].status).toBe("ready");
			expect(after.queue).toEqual([goal.id]);

			expect(
				await fetch(`${base}/api/nope`, { headers: auth }).then(
					(r) => r.status,
				),
			).toBe(404);
		} finally {
			server.stop(true);
			await rm(uiDir, { recursive: true, force: true });
			await ws.cleanup();
		}
	});

	test("rejects requests with a non-loopback host (DNS rebinding)", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		const server = await createUiServer(ws.bb, 0);
		try {
			// attacker page after rebinding evil.com → 127.0.0.1: the Host header
			// betrays it; port-agnostic loopback hostnames are the only way in
			const rebound = new Request("http://evil.com:7700/api/bootstrap");
			const response = await server.handle(rebound);
			expect(response.status).toBe(403);
		} finally {
			server.stop(true);
			await ws.cleanup();
		}
	});

	test("POST /api/sync returns 409 while another runOnce holds the run lock", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		const server = await createUiServer(ws.bb, 0);
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const token = await fetch(`${base}/api/bootstrap`)
				.then((r) => r.json())
				.then((b: { token: string }) => b.token);
			const auth = { "x-workbench-token": token };

			const holder = await acquirePidLock(join(ws.workbenchRoot, "run.lock"));
			try {
				const response = await fetch(`${base}/api/sync`, {
					method: "POST",
					headers: auth,
				});
				expect(response.status).toBe(409);
				expect((await response.json()).busy).toBe(true);
			} finally {
				await holder.release();
			}
			expect(
				(await fetch(`${base}/api/sync`, { method: "POST", headers: auth }))
					.status,
			).toBe(200);
		} finally {
			server.stop(true);
			await ws.cleanup();
		}
	});
});

describe("ui chat routes", () => {
	test("reload route is reachable and resend does not duplicate the user message", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		// fake claude CLI: consumes the prompt from stdin, then emits two
		// stream-json events (assistant text + result) and exits
		const fakeDir = await mkdtemp(join(tmpdir(), "workbench-fake-agent-"));
		const fakeAgent = join(fakeDir, "fake-agent.ts");
		await writeFile(
			fakeAgent,
			[
				"const emit = (event: Record<string, unknown>) =>",
				"  process.stdout.write(JSON.stringify(event) + '\\n');",
				'emit({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] }, session_id: "fake-1" });',
				'emit({ type: "result", subtype: "success", result: "ok" });',
				'process.stdin.setEncoding("utf8");',
				'process.stdin.on("data", () => {});',
				'process.stdin.on("end", () => process.exit(0));',
				"setInterval(() => {}, 1000);",
			].join("\n"),
			"utf8",
		);
		const previousCommand = process.env.WORKBENCH_CHAT_COMMAND;
		process.env.WORKBENCH_CHAT_COMMAND = `bun ${fakeAgent}`;
		const server = await createUiServer(ws.bb, 0);
		const base = `http://127.0.0.1:${server.port}`;
		const token = await fetch(`${base}/api/bootstrap`)
			.then((r) => r.json())
			.then((b: { token: string }) => b.token);
		const auth = {
			"x-workbench-token": token,
			"content-type": "application/json",
		};
		let id = "";
		try {
			const thread = await fetch(`${base}/api/chat/threads`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({}),
			}).then((r) => r.json());
			id = (thread as { id: string }).id;

			// the reload sub-route used to fall out of the regex and 404
			const emptyReload = await fetch(`${base}/api/chat/threads/${id}/reload`, {
				method: "POST",
				headers: auth,
			}).then((r) => r.json());
			expect((emptyReload as { ok: boolean; reason?: string }).ok).toBe(false);

			const read = () =>
				fetch(`${base}/api/chat/threads/${id}`, { headers: auth })
					.then((r) => r.json())
					.then(
						(b: { messages: { role: string; text: string }[] }) => b.messages,
					);

			// normal run: user + assistant
			await fetch(`${base}/api/chat/threads/${id}/messages`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ text: "hi" }),
			}).then((r) => r.text());
			let messages = await read();
			expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);

			// reload truncates the assistant message
			const reload = await fetch(`${base}/api/chat/threads/${id}/reload`, {
				method: "POST",
				headers: auth,
			}).then((r) => r.json());
			expect((reload as { ok: boolean }).ok).toBe(true);
			messages = await read();
			expect(messages.map((m) => m.role)).toEqual(["user"]);

			// resend: the user message must NOT be appended a second time
			await fetch(`${base}/api/chat/threads/${id}/messages`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ text: "hi", resend: true }),
			}).then((r) => r.text());
			messages = await read();
			expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
		} finally {
			// the fake agent's cwd is inside the temp workbench and it lives on
			// between turns (SESSION_IDLE_CLOSE_MS is minutes); kill it before
			// rm or Windows reports EBUSY on the locked directory
			await fetch(`${base}/api/chat/threads/${id}/cancel`, {
				method: "POST",
				headers: { "x-workbench-token": token },
			}).catch(() => {});
			server.stop(true);
			if (previousCommand === undefined) {
				delete process.env.WORKBENCH_CHAT_COMMAND;
			} else {
				process.env.WORKBENCH_CHAT_COMMAND = previousCommand;
			}
			await rm(fakeDir, { recursive: true, force: true });
			await ws.cleanup();
		}
	}, 20000);

	test("cancel kills the agent process tree, not just the shim", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		const fakeDir = await mkdtemp(join(tmpdir(), "workbench-cancel-agent-"));
		// the fake agent records its own pid, then sleeps forever — the
		// cancel must make THIS pid disappear (tree kill), which is the
		// S0 acceptance criterion for chat cancellation
		await writeFile(
			join(fakeDir, "sleeper-agent.js"),
			[
				'const { writeFileSync } = require("node:fs");',
				'writeFileSync(process.argv[1] + ".pid", String(process.pid));',
				"setInterval(() => {}, 1000);",
			].join("\n"),
			"utf8",
		);
		const previousCommand = process.env.WORKBENCH_CHAT_COMMAND;
		process.env.WORKBENCH_CHAT_COMMAND = `bun ${join(fakeDir, "sleeper-agent.js")}`;
		const server = await createUiServer(ws.bb, 0);
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const token = await fetch(`${base}/api/bootstrap`)
				.then((r) => r.json())
				.then((b: { token: string }) => b.token);
			const auth = {
				"x-workbench-token": token,
				"content-type": "application/json",
			};

			const thread = await fetch(`${base}/api/chat/threads`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({}),
			}).then((r) => r.json());
			const id = (thread as { id: string }).id;

			// start the run; the streaming response stays open while the
			// fake agent sleeps
			void fetch(`${base}/api/chat/threads/${id}/messages`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ text: "hi" }),
			});

			const { readFile } = await import("node:fs/promises");
			const pidFile = join(fakeDir, "sleeper-agent.js.pid");
			await pollUntil(async () => {
				try {
					await readFile(pidFile, "utf8");
					return true;
				} catch {
					return false;
				}
			}, 8000);
			const agentPid = Number(await readFile(pidFile, "utf8"));
			expect(isProcessAlive(agentPid)).toBe(true);

			// cancel → the process really disappears
			await fetch(`${base}/api/chat/threads/${id}/cancel`, {
				method: "POST",
				headers: auth,
			});
			await pollUntil(() => {
				try {
					process.kill(agentPid, 0);
					return false;
				} catch {
					return true;
				}
			}, 8000);
		} finally {
			server.stop(true);
			if (previousCommand === undefined) {
				delete process.env.WORKBENCH_CHAT_COMMAND;
			} else {
				process.env.WORKBENCH_CHAT_COMMAND = previousCommand;
			}
			await rm(fakeDir, { recursive: true, force: true });
			await ws.cleanup();
		}
	}, 20000);

	test("threads mint uuid ids, --session-id/--resume, and capture file footprints", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		const fakeDir = await mkdtemp(join(tmpdir(), "workbench-fp-agent-"));
		// fake claude: logs its argv (to verify --session-id / --resume),
		// then emits a Read tool call + result and a Write tool call + result
		await writeFile(
			join(fakeDir, "fp-agent.js"),
			[
				// A *persistent* fake agent: the real claude CLI stays alive
				// across turns (streaming stdin), so this stand-in must too —
				// otherwise every turn after the first writes to a dead child
				// and nothing observable happens.
				'const { appendFileSync, writeFileSync } = require("node:fs");',
				'const { join } = require("node:path");',
				'appendFileSync(join(__dirname, "argv.log"), JSON.stringify(process.argv.slice(1)) + "\\n");',
				'const readTarget = join(process.cwd(), "readme.md");',
				'const writeTarget = join(process.cwd(), "generated.txt");',
				'const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");',
				'const sessionArg = process.argv.includes("--session-id")',
				'  ? process.argv[process.argv.indexOf("--session-id") + 1]',
				'  : process.argv[process.argv.indexOf("--resume") + 1];',
				'line({ type: "system", subtype: "init", session_id: sessionArg });',
				"let turn = 0;",
				// behaviour is keyed on the prompt text, not the turn counter:
				// the respawned child starts counting at 1 again
				"const onTurn = (raw) => {",
				'  let text = "";',
				'  try { text = JSON.parse(raw)?.message?.content ?? ""; } catch {}',
				"  turn += 1;",
				'  if (text === "go") {',
				'    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: readTarget } }] } });',
				'    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "readme content" }] } });',
				'    line({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: writeTarget, content: "new" } }] } });',
				'    writeFileSync(writeTarget, "written by fake agent");',
				'    line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } });',
				'    line({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });',
				'    line({ type: "result", subtype: "success", result: "done" });',
				"    return;",
				"  }",
				'  line({ type: "assistant", message: { content: [{ type: "text", text: "reply " + turn }] } });',
				'  line({ type: "result", subtype: "success", result: "reply " + turn });',
				// the last prompt exits the child so the test can clean up its
				// cwd (a live process keeps the directory locked on Windows)
				'  if (text === "again" || text === "once more") { setTimeout(() => process.exit(0), 10); }',
				"};",
				'let buf = "";',
				'process.stdin.setEncoding("utf8");',
				'process.stdin.on("data", (chunk) => {',
				"  buf += chunk;",
				// one JSON per line, but the very first turn is written without
				// a trailing newline, so also accept a complete value with none
				"  for (;;) {",
				'    const nl = buf.indexOf("\\n");',
				"    if (nl >= 0) {",
				"      const raw = buf.slice(0, nl).trim();",
				"      buf = buf.slice(nl + 1);",
				"      if (raw) { onTurn(raw); }",
				"      continue;",
				"    }",
				"    const trimmed = buf.trim();",
				"    if (!trimmed) { break; }",
				"    try { JSON.parse(trimmed); } catch { break; }",
				'    buf = "";',
				"    onTurn(trimmed);",
				"  }",
				"});",
				'process.stdin.on("end", () => process.exit(0));',
			].join("\n"),
			"utf8",
		);
		const previousCommand = process.env.WORKBENCH_CHAT_COMMAND;
		process.env.WORKBENCH_CHAT_COMMAND = `bun ${join(fakeDir, "fp-agent.js")}`;
		const server = await createUiServer(ws.bb, 0);
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const token = await fetch(`${base}/api/bootstrap`)
				.then((r) => r.json())
				.then((b: { token: string }) => b.token);
			const auth = {
				"x-workbench-token": token,
				"content-type": "application/json",
			};
			await writeFile(join(ws.projectDir, "readme.md"), "readme content");

			const thread = await fetch(`${base}/api/chat/threads`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({}),
			}).then((r) => r.json());
			const id = (thread as { id: string }).id;
			// the thread id IS the claude session id (uuid, minted by us)
			expect(id).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
			expect((thread as { claudeSessionId?: string }).claudeSessionId).toBe(id);

			await fetch(`${base}/api/chat/threads/${id}/messages`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ text: "go" }),
			}).then((r) => r.text());

			// first run minted the id via --session-id
			const argv1 = JSON.parse(
				(await readFile(join(fakeDir, "argv.log"), "utf8"))
					.trim()
					.split("\n")[0] ?? "[]",
			) as string[];
			expect(argv1).toContain("--session-id");
			expect(argv1).toContain(id);

			// footprint: one entry per tool call, with versions hashed
			const { isAbsolute } = await import("node:path");
			expect(isAbsolute(id)).toBe(false);
			const footprint = await ws.bb.sessions.footprint(id);
			expect(footprint).toHaveLength(2);
			const readEntry = footprint[0]!;
			expect(readEntry.used[0]?.path.replace(/\\/g, "/")).toContain(
				"readme.md",
			);
			expect(readEntry.used[0]?.version).toBeTruthy();
			const writeEntry = footprint[1]!;
			expect(writeEntry.generated[0]?.path.replace(/\\/g, "/")).toContain(
				"generated.txt",
			);
			expect(writeEntry.generated[0]?.version).toBeTruthy();

			// the writer is registered as an agent citizen
			const writer = await ws.bb.sessions.get(id);
			expect(writer?.kind).toBe("agent");

			// second turn reuses the live session: the child is still running,
			// so nothing respawns and argv.log keeps its single entry
			await fetch(`${base}/api/chat/threads/${id}/messages`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ text: "again" }),
			}).then((r) => r.text());
			const argvLines = (await readFile(join(fakeDir, "argv.log"), "utf8"))
				.trim()
				.split("\n");
			expect(argvLines).toHaveLength(1);

			// the fake agent exits after turn 2; once the runtime reaps the
			// child, the next turn respawns and resumes the same session id
			const respawnDeadline = Date.now() + 5000;
			let respawnCount = 0;
			do {
				await new Promise((resolve) => setTimeout(resolve, 50));
				respawnCount = (await readFile(join(fakeDir, "argv.log"), "utf8"))
					.trim()
					.split("\n")
					.filter(Boolean).length;
			} while (respawnCount < 2 && Date.now() < respawnDeadline);
			await fetch(`${base}/api/chat/threads/${id}/messages`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ text: "once more" }),
			}).then((r) => r.text());
			const respawnLines = (await readFile(join(fakeDir, "argv.log"), "utf8"))
				.trim()
				.split("\n");
			expect(respawnLines).toHaveLength(2);
			const argv2 = JSON.parse(respawnLines[1] ?? "[]") as string[];
			expect(argv2).toContain("--resume");
			expect(argv2).toContain(id);
		} finally {
			server.stop(true);
			if (previousCommand === undefined) {
				delete process.env.WORKBENCH_CHAT_COMMAND;
			} else {
				process.env.WORKBENCH_CHAT_COMMAND = previousCommand;
			}
			await rm(fakeDir, { recursive: true, force: true });
			await ws.cleanup();
		}
	}, 20000);

	test("fork route: anchor gesture creates a sibling thread and leaves the source untouched", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		const server = await createUiServer(ws.bb, 0);
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const token = await fetch(`${base}/api/bootstrap`)
				.then((r) => r.json())
				.then((b: { token: string }) => b.token);
			const auth = {
				"x-workbench-token": token,
				"content-type": "application/json",
			};

			const thread = await fetch(`${base}/api/chat/threads`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({}),
			}).then((r) => r.json());
			const id = (thread as { id: string }).id;

			// seed a 3-message transcript directly on disk (fork runs no agent)
			const mk = (id: string, role: "user" | "assistant", text: string) => ({
				id,
				role,
				text,
				at: new Date().toISOString(),
			});
			const seeded = [
				mk("m-1", "user", "第一问"),
				mk("m-2", "assistant", "第一答"),
				mk("m-3", "user", "第二问"),
			];
			const { appendFile } = await import("node:fs/promises");
			for (const m of seeded) {
				await appendFile(
					join(ws.workbenchRoot, "threads", id, "messages.jsonl"),
					`${JSON.stringify(m)}\n`,
					"utf8",
				);
			}

			// missing anchor → 400
			const noAnchor = await fetch(`${base}/api/chat/threads/${id}/fork`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({}),
			});
			expect(noAnchor.status).toBe(400);

			// unknown anchor → ok:false
			const unknown = await fetch(`${base}/api/chat/threads/${id}/fork`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ anchorMessageId: "m-nope" }),
			}).then((r) => r.json());
			expect((unknown as { ok: boolean }).ok).toBe(false);

			// fork at m2: inherits [m1, m2], declaration present
			const outcome = await fetch(`${base}/api/chat/threads/${id}/fork`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({ anchorMessageId: "m-2" }),
			}).then((r) => r.json());
			const forked = outcome as {
				ok: boolean;
				thread: { id: string; forkOf: { sourceThreadId: string } };
				declaration: { inheritedMessages: number };
			};
			expect(forked.ok).toBe(true);
			expect(forked.thread.id).not.toBe(id);
			expect(forked.thread.forkOf.sourceThreadId).toBe(id);
			expect(forked.declaration.inheritedMessages).toBe(2);

			const readMessages = (threadId: string) =>
				fetch(`${base}/api/chat/threads/${threadId}`, { headers: auth })
					.then((r) => r.json())
					.then((b: { messages: { id: string }[] }) => b.messages);
			expect((await readMessages(forked.thread.id)).map((m) => m.id)).toEqual([
				"m-1",
				"m-2",
			]);
			// source transcript untouched
			expect((await readMessages(id)).map((m) => m.id)).toEqual([
				"m-1",
				"m-2",
				"m-3",
			]);
		} finally {
			server.stop(true);
			await ws.cleanup();
		}
	}, 20000);
});

describe("resume note routes (TF-0097)", () => {
	test("leave generates a resume note; GET carries it; PATCH confirms", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		const server = await createUiServer(ws.bb, 0);
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const token = await fetch(`${base}/api/bootstrap`)
				.then((r) => r.json())
				.then((b: { token: string }) => b.token);
			const auth = {
				"x-workbench-token": token,
				"content-type": "application/json",
			};

			const thread = await fetch(`${base}/api/chat/threads`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({}),
			}).then((r) => r.json());
			const id = (thread as { id: string }).id;

			// seed a 2-message transcript
			const mk = (mid: string, role: "user" | "assistant", text: string) => ({
				id: mid,
				role,
				text,
				at: new Date().toISOString(),
			});
			const { appendFile } = await import("node:fs/promises");
			for (const m of [
				mk("m-1", "user", "调研恢复笔记"),
				mk("m-2", "assistant", "好"),
			]) {
				await appendFile(
					join(ws.workbenchRoot, "threads", id, "messages.jsonl"),
					`${JSON.stringify(m)}\n`,
					"utf8",
				);
			}

			// leave → resume note present
			const note = (await fetch(`${base}/api/chat/threads/${id}/leave`, {
				method: "POST",
				headers: auth,
			}).then((r) => r.json())) as {
				beats: { kind: string }[];
				draftedAt: string;
				confirmedAt?: string;
			} | null;
			expect(note).not.toBeNull();
			expect(note!.beats.length).toBeGreaterThanOrEqual(1);
			expect(note!.confirmedAt).toBeUndefined();

			// GET carries resumeNote
			const got = (await fetch(`${base}/api/chat/threads/${id}`, {
				headers: auth,
			}).then((r) => r.json())) as { resumeNote: { beats: unknown[] } | null };
			expect(got.resumeNote).not.toBeNull();
			expect(got.resumeNote!.beats.length).toBe(note!.beats.length);

			// PATCH confirm → confirmedAt set
			const confirmed = (await fetch(
				`${base}/api/chat/threads/${id}/resume-note`,
				{
					method: "PATCH",
					headers: auth,
					body: JSON.stringify({ confirmed: true }),
				},
			).then((r) => r.json())) as { confirmedAt?: string };
			expect(confirmed.confirmedAt).toBeDefined();
		} finally {
			server.stop(true);
			await ws.cleanup();
		}
	}, 20000);

	test("leave on empty thread returns null; PATCH on note-less thread returns 404", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		const server = await createUiServer(ws.bb, 0);
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const token = await fetch(`${base}/api/bootstrap`)
				.then((r) => r.json())
				.then((b: { token: string }) => b.token);
			const auth = {
				"x-workbench-token": token,
				"content-type": "application/json",
			};

			const thread = await fetch(`${base}/api/chat/threads`, {
				method: "POST",
				headers: auth,
				body: JSON.stringify({}),
			}).then((r) => r.json());
			const id = (thread as { id: string }).id;

			const empty = await fetch(`${base}/api/chat/threads/${id}/leave`, {
				method: "POST",
				headers: auth,
			}).then((r) => r.json());
			expect(empty).toBeNull();

			const noNote = await fetch(`${base}/api/chat/threads/${id}/resume-note`, {
				method: "PATCH",
				headers: auth,
				body: JSON.stringify({ confirmed: true }),
			});
			expect(noNote.status).toBe(404);
		} finally {
			server.stop(true);
			await ws.cleanup();
		}
	}, 20000);
});

async function pollUntil(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("pollUntil timed out");
}
