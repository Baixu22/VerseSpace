import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";

export interface E2EWorkspace {
	projectDir: string;
	entry: string;
	agentScript: string;
}

export const execPath = process.execPath;
const freePort = (): Promise<number> =>
	new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => (port ? resolve(port) : reject(new Error("no port"))));
		});
		server.on("error", reject);
	});

const quote = (path: string): string => (/\s/.test(path) ? `"${path}"` : path);

export function cli(
	ws: E2EWorkspace,
	args: string[],
	timeoutMs = 30_000,
): Promise<{
	code: number | null;
	stdout: string;
	stderr: string;
}> {
	return new Promise((done, fail) => {
		const proc = spawn(execPath, [ws.entry, ...args], {
			cwd: ws.projectDir,
			windowsHide: true,
			env: { ...process.env },
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
		proc.stdout.on("data", (chunk) => (stdout += String(chunk)));
		proc.stderr.on("data", (chunk) => (stderr += String(chunk)));
		proc.on("exit", (code) => {
			clearTimeout(timer);
			done({ code, stdout, stderr });
		});
		proc.on("error", (error) => {
			clearTimeout(timer);
			fail(error);
		});
	});
}

export async function cliJson<T>(ws: E2EWorkspace, args: string[]): Promise<T> {
	const out = await cli(ws, ["--json", ...args]);
	if (out.code !== 0) {
		throw new Error(
			`workbench ${args.join(" ")} 退出 ${out.code}：${out.stderr}`,
		);
	}
	const start = out.stdout.indexOf("{");
	return JSON.parse(out.stdout.slice(start)) as T;
}

export interface Server {
	port: number;
	token: string;
	proc: ReturnType<typeof spawn>;
	stop: () => Promise<void>;
}

export async function startServer(ws: E2EWorkspace): Promise<Server> {
	const port = await freePort();
	const proc = spawn(
		execPath,
		[ws.entry, "ui", "--port", String(port), "--no-open"],
		{
			cwd: ws.projectDir,
			windowsHide: true,
			env: {
				...process.env,
				// Both deterministic and live-model actors use the real process path.
				WORKBENCH_CHAT_COMMAND: `${quote(execPath)} ${quote(ws.agentScript)}`,
				WORKBENCH_CHAT_API_KEY:
					process.env.E2E_LLM_KEY ?? process.env.WORKBENCH_CHAT_API_KEY,
			},
		},
	);
	let stderr = "";
	proc.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
		// 服务进程崩溃时的第一现场必须留在跑批日志里，否则只剩一个
		// 「socket closed」而不知道谁死的。
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

export function api(
	server: Server,
	path: string,
	init?: RequestInit,
): Promise<Response> {
	return fetch(`http://127.0.0.1:${server.port}${path}`, {
		...init,
		headers: {
			"x-workbench-token": server.token,
			...(init?.body ? { "content-type": "application/json" } : {}),
			...(init?.headers ?? {}),
			// S4 的轮询会闲置连接十几秒，服务端先关 keep-alive 时复用旧连接
			// 会报 socket closed——E2E 一律短连接。
			connection: "close",
		},
	});
}

interface Ndjson {
	type: string;
	[key: string]: unknown;
}

/** 消费消息流的 NDJSON，直到 done/error——就是 UI 收到的真实事件序列。 */
export async function sendTurn(
	server: Server,
	threadId: string,
	text: string,
): Promise<Ndjson[]> {
	const res = await api(server, `/api/chat/threads/${threadId}/messages`, {
		method: "POST",
		body: JSON.stringify({ text }),
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok || !res.body) {
		throw new Error(`messages ${res.status}：${await res.text()}`);
	}
	const events: Ndjson[] = [];
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			const event = JSON.parse(line) as Ndjson;
			events.push(event);
			if (event.type === "error") {
				const detail = String(event.message ?? "未知提供方错误");
				const key =
					process.env.E2E_LLM_KEY ?? process.env.WORKBENCH_CHAT_API_KEY;
				throw new Error(
					`消息回合失败：${key ? detail.split(key).join("[REDACTED]") : detail}`,
				);
			}
			if (event.type === "done") {
				return events;
			}
		}
	}
	throw new Error(`消息流 60s 未收尾，已收 ${events.length} 条`);
}

export async function waitFor(
	describe: string,
	probe: () => Promise<boolean>,
	timeoutMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await probe()) return;
		await new Promise((r) => setTimeout(r, 1_000));
	}
	throw new Error(`等待超时（${timeoutMs}ms）：${describe}`);
}

export async function lastEventId(
	ws: E2EWorkspace,
	type: string,
): Promise<string | null> {
	const event = await lastEventFor(ws, type);
	return event?.id ?? null;
}

export async function lastEventFor(
	ws: E2EWorkspace,
	type: string,
	writerId?: string,
): Promise<{ id: string; payload: Record<string, unknown> } | null> {
	const lines = splitLines(
		await readFile(
			join(ws.projectDir, ".workbench", "events", "events.jsonl"),
			"utf8",
		),
	);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const event = JSON.parse(lines[i]!) as {
			type: string;
			id?: string;
			payload?: Record<string, unknown>;
		};
		if (event.type !== type || !event.id) continue;
		if (
			writerId !== undefined &&
			(event.payload as { writer?: string } | undefined)?.writer !== writerId
		) {
			continue;
		}
		return { id: event.id, payload: event.payload ?? {} };
	}
	return null;
}

const splitLines = (text: string): string[] => text.trim().split(/\r?\n/);

export const git = (ws: E2EWorkspace, args: string[]): Promise<void> =>
	new Promise((done, fail) => {
		const proc = spawn("git", args, { cwd: ws.projectDir });
		proc.on("exit", (code) =>
			code === 0 ? done() : fail(new Error(`git ${args.join(" ")} -> ${code}`)),
		);
		proc.on("error", fail);
	});
