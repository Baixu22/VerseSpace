/**
 * TF-0190 受控试用：UI chat 车道足迹验证（复用 scripts/e2e 的驱动 harness）。
 *
 * 用法（在 packages/workbench 下运行）：
 *   bun ../../.agent-contexts/tf0190-trial/ui-lane-trial.ts claude
 *   bun ../../.agent-contexts/tf0190-trial/ui-lane-trial.ts http
 *
 * claude 车道：真实 claude CLI（默认 WORKBENCH_CHAT_COMMAND），期望 withFootprints > 0。
 * http 车道：openai-chat + DPAPI 凭据（senseaudio），对照组，期望 withFootprints = 0。
 */
import { spawn } from "node:child_process";
import net from "node:net";
import { join, resolve } from "node:path";
import { loadLiveModelCredentials } from "../../packages/workbench/scripts/e2e/live-credentials.ts";
import {
	api,
	cli,
	cliJson,
	type E2EWorkspace,
	type Server,
} from "../../packages/workbench/scripts/e2e/driver.ts";
import {
	makeTempWorkspace,
	seedProject,
} from "../../packages/workbench/scripts/e2e/fixtures.ts";

const lane = process.argv[2];
if (lane !== "claude" && lane !== "http") {
	console.error("用法：ui-lane-trial.ts <claude|http>");
	process.exit(2);
}

const freePort = (): Promise<number> =>
	new Promise((resolvePort, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => (port ? resolvePort(port) : reject(new Error("no port"))));
		});
		server.on("error", reject);
	});

/** 启动 UI 服务；claude 车道不覆盖 WORKBENCH_CHAT_COMMAND，http 车道注入 API key。 */
async function startLaneServer(
	ws: E2EWorkspace,
	lane: "claude" | "http",
): Promise<Server> {
	const port = await freePort();
	const env: Record<string, string> = { ...process.env };
	if (lane === "http") {
		const cred = loadLiveModelCredentials({ require: true });
		env.WORKBENCH_CHAT_API_KEY = cred.key;
	}
	const proc = spawn(
		process.execPath,
		[ws.entry, "ui", "--port", String(port), "--no-open"],
		{ cwd: ws.projectDir, windowsHide: true, env },
	);
	let stderr = "";
	proc.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
		process.stderr.write(`[ui] ${String(chunk)}`);
	});
	const token = await (async () => {
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			if (proc.exitCode !== null) {
				throw new Error(`ui 服务提前退出：${stderr.slice(0, 400)}`);
			}
			try {
				const res = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
				if (res.ok) {
					const body = (await res.json()) as { token: string };
					return body.token;
				}
			} catch {
				// not up yet
			}
			await new Promise((r) => setTimeout(r, 300));
		}
		throw new Error(`ui 服务 20s 未就绪：${stderr.slice(0, 400)}`);
	})();
	return {
		port,
		token,
		proc,
		stop: () =>
			new Promise((done) => {
				proc.on("exit", () => done());
				proc.kill();
				setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {
						// already gone
					}
					done();
				}, 3_000);
			}),
	};
}

const PROMPT = [
	"请用 Read 读取 src/alpha.ts 与 src/notes.md，然后用 Write 把 src/alpha.ts 改为 v2（内容：export const alpha = \"v2\";）。",
	"不要修改其他文件，完成后用一句话说明改动。",
].join("\n");

const ws = await makeTempWorkspace();
await seedProject(ws);
console.log(`[trial:${lane}] 工作区：${ws.projectDir}`);

if (lane === "http") {
	for (const [key, value] of [
		["chat.provider", "openai-chat"],
		["chat.baseUrl", "https://api.senseaudio.cn/v1"],
		["chat.model", "senseaudio-s2-flash"],
	]) {
		const r = await cli(ws, ["config", "set", key, value]);
		if (r.code !== 0) throw new Error(`config set ${key} 失败：${r.stderr}`);
	}
	console.log(`[trial:http] provider=openai-chat / baseUrl / model 已写入配置`);
}

const server = await startLaneServer(ws, lane);
try {
	const created = await (
		await api(server, "/api/chat/threads", {
			method: "POST",
			body: JSON.stringify({ title: `TF-0190 ${lane} 车道试用` }),
		})
	).json() as { id: string };
	const threadId = created.id;
	console.log(`[trial:${lane}] 线程：${threadId}`);

	const res = await api(server, `/api/chat/threads/${threadId}/messages`, {
		method: "POST",
		body: JSON.stringify({ text: PROMPT }),
		signal: AbortSignal.timeout(300_000),
	});
	if (!res.ok || !res.body) throw new Error(`messages ${res.status}`);
	const events: Array<Record<string, unknown>> = [];
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			const event = JSON.parse(line) as Record<string, unknown>;
			events.push(event);
			if (event.type === "error") throw new Error(`回合错误：${String(event.message)}`);
			if (event.type === "done") break;
		}
		if (events.some((e) => e.type === "done")) break;
	}
	const toolParts = events.flatMap((e) =>
		e.type === "parts" && Array.isArray(e.parts)
			? (e.parts as Array<Record<string, unknown>>).filter((p) => p.type === "tool-call")
			: [],
	);
	console.log(
		`[trial:${lane}] 回合完成：事件 ${events.length} 条，tool-call part ${toolParts.length} 个（${toolParts.map((p) => String(p.toolName)).join(",")}）`,
	);

	await server.stop();
	const stats = await cliJson<{ threads: { withFootprints: number; total: number } }>(ws, [
		"stats",
	]);
	console.log(
		`[trial:${lane}] stats.threads = ${JSON.stringify(stats.threads)}`,
	);
	console.log(
		`[trial:${lane}] RESULT: withFootprints=${stats.threads.withFootprints} (${stats.threads.withFootprints > 0 ? "PASS" : lane === "claude" ? "FAIL" : "PASS(对照)"})`,
	);
} finally {
	await server.stop().catch(() => {});
}
