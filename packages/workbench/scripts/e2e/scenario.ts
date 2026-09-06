/**
 * 真进程端到端场景（工程探索样本源，2026-09-06 用户决策）。
 *
 * 参与者全部是真实组件：真 CLI 子进程（`workbench init` / `sessions record` /
 * `premises seal` / `review-seal` / `context` / `stats` / fit-ledger）、真 HTTP
 * 服务（createUiServer 的完整路由面）、真 git 仓库、真文件系统，以及一个以
 * stream-json 协议对话的确定性 agent 进程（scripts/e2e/fake-agent.ts）。
 * 不 import 任何被测库——一切通过公开表面驱动，这是它和单元测试的边界。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface E2EWorkspace {
	projectDir: string;
	entry: string;
	fakeAgent: string;
}

export interface StepReport {
	step: string;
	ok: boolean;
	detail: Record<string, unknown>;
}

export interface E2EReport {
	projectDir: string;
	steps: StepReport[];
	stats: Record<string, unknown> | null;
	ledgerT0: Record<string, unknown> | null;
	sampleWindow: Record<string, unknown> | null;
	ok: boolean;
}

const execPath = process.execPath;
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

export async function makeTempWorkspace(): Promise<E2EWorkspace> {
	const root = await mkdtemp(join(tmpdir(), "workbench-e2e-"));
	const entry = resolve(import.meta.dir, "..", "..", "src", "index.ts");
	return {
		projectDir: root,
		entry,
		fakeAgent: resolve(import.meta.dir, "fake-agent.ts"),
	};
}

/** 一个真实 git 仓库 + 种子文件 + `workbench init` 落出的 .workbench。 */
async function seedProject(ws: E2EWorkspace): Promise<void> {
	const git = (args: string[]) =>
		new Promise<void>((done, fail) => {
			const proc = spawn("git", args, { cwd: ws.projectDir });
			proc.on("exit", (code) =>
				code === 0
					? done()
					: fail(new Error(`git ${args.join(" ")} -> ${code}`)),
			);
			proc.on("error", fail);
		});
	const { mkdir } = await import("node:fs/promises");
	await mkdir(join(ws.projectDir, "src"), { recursive: true });
	await writeFile(
		join(ws.projectDir, "src", "notes.md"),
		"# notes\n\n集成测试种子文件。\n",
		"utf8",
	);
	await writeFile(
		join(ws.projectDir, "src", "alpha.ts"),
		'export const alpha = "v1";\n',
		"utf8",
	);
	await writeFile(
		join(ws.projectDir, "src", "beta.ts"),
		"export const beta = 1;\n",
		"utf8",
	);
	await git(["init"]);
	await git(["-c", "user.email=e2e@local", "-c", "user.name=e2e", "add", "."]);
	await git([
		"-c",
		"user.email=e2e@local",
		"-c",
		"user.name=e2e",
		"commit",
		"-m",
		"seed",
	]);
	await cli(ws, ["--json", "init", "--project", ws.projectDir]);
	if (!existsSync(join(ws.projectDir, ".workbench"))) {
		throw new Error("workbench init 未产出 .workbench");
	}
}

function cli(
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

async function cliJson<T>(ws: E2EWorkspace, args: string[]): Promise<T> {
	const out = await cli(ws, ["--json", ...args]);
	if (out.code !== 0) {
		throw new Error(
			`workbench ${args.join(" ")} 退出 ${out.code}：${out.stderr}`,
		);
	}
	const start = out.stdout.indexOf("{");
	return JSON.parse(out.stdout.slice(start)) as T;
}

interface Server {
	port: number;
	token: string;
	proc: ReturnType<typeof spawn>;
	stop: () => Promise<void>;
}

async function startServer(ws: E2EWorkspace): Promise<Server> {
	const port = await freePort();
	const proc = spawn(execPath, [ws.entry, "ui", "--port", String(port)], {
		cwd: ws.projectDir,
		env: {
			...process.env,
			// The chat runner reads this per-spawn; the fake agent is a real
			// child process of the real server process.
			WORKBENCH_CHAT_COMMAND: `${quote(execPath)} ${quote(ws.fakeAgent)}`,
		},
	});
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

function api(
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
async function sendTurn(
	server: Server,
	threadId: string,
	text: string,
): Promise<Ndjson[]> {
	const res = await api(server, `/api/chat/threads/${threadId}/messages`, {
		method: "POST",
		body: JSON.stringify({ text }),
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
			if (event.type === "done" || event.type === "error") {
				return events;
			}
		}
	}
	throw new Error(`消息流 60s 未收尾，已收 ${events.length} 条`);
}

async function waitFor(
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

async function lastEventId(
	ws: E2EWorkspace,
	type: string,
): Promise<string | null> {
	const event = await lastEventFor(ws, type);
	return event?.id ?? null;
}

async function lastEventFor(
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

const git = (ws: E2EWorkspace, args: string[]): Promise<void> =>
	new Promise((done, fail) => {
		const proc = spawn("git", args, { cwd: ws.projectDir });
		proc.on("exit", (code) =>
			code === 0 ? done() : fail(new Error(`git ${args.join(" ")} -> ${code}`)),
		);
		proc.on("error", fail);
	});

/**
 * 跑完整场景。`label` 只进报告；所有断言失败直接抛错，由调用方决定
 * 是让测试失败（e2e.test.ts）还是记进租户报告（run.ts）。
 */
export async function runE2E(
	ws: E2EWorkspace,
	options: { keepWorkspace?: boolean } = {},
): Promise<E2EReport> {
	const steps: StepReport[] = [];
	const report: E2EReport = {
		projectDir: ws.projectDir,
		steps,
		stats: null,
		ledgerT0: null,
		sampleWindow: null,
		ok: false,
	};
	const step = async <T>(name: string, body: () => Promise<T>): Promise<T> => {
		process.stderr.write(`[e2e] ▶ ${name}\n`);
		try {
			const detail = await body();
			process.stderr.write(`[e2e] ✓ ${name}\n`);
			steps.push({
				step: name,
				ok: true,
				detail: { detail } as Record<string, unknown>,
			});
			return detail;
		} catch (error) {
			process.stderr.write(`[e2e] ✗ ${name}: ${String(error).slice(0, 300)}\n`);
			steps.push({
				step: name,
				ok: false,
				detail: { error: String(error) },
			});
			throw error;
		}
	};

	await step("seed: git 仓库 + workbench init", () => seedProject(ws));
	const server = await step("server: 真进程 ui 服务启动", () =>
		startServer(ws),
	);

	try {
		const thread = await step("S0 建线程", async () => {
			const res = await api(server, "/api/chat/threads", {
				method: "POST",
				body: JSON.stringify({ title: "E2E 集成线程" }),
			});
			const meta = (await res.json()) as { id: string };
			if (!meta.id) throw new Error("create 未返回线程 id");
			return meta;
		});
		const threadId = thread.id;

		await step("S1 agent 真进程回合：读 notes + 写 alpha v2", async () => {
			const events = await sendTurn(
				server,
				threadId,
				[
					"请处理以下任务。",
					"READ src/notes.md",
					"WRITE src/alpha.ts",
					'export const alpha = "v2";',
					"__END_WRITE__",
				].join("\n"),
			);
			const types = events.map((e) => e.type);
			for (const expected of ["user", "delta", "done"]) {
				if (!types.includes(expected)) {
					throw new Error(`事件流缺 ${expected}：${types.join(",")}`);
				}
			}
			const onDisk = await readFile(
				join(ws.projectDir, "src", "alpha.ts"),
				"utf8",
			);
			if (!onDisk.includes("v2")) throw new Error("agent 没有真正写盘");
			return { events: types.length, onDisk: "v2" };
		});

		await step("S2 离开线程（leave）", async () => {
			const res = await api(server, `/api/chat/threads/${threadId}/leave`, {
				method: "POST",
			});
			const note = (await res.json()) as { beats?: unknown[] } | null;
			if (!note || !Array.isArray(note.beats) || note.beats.length === 0) {
				throw new Error("leave 未产出恢复笔记");
			}
			return note;
		});

		await step("S3 git 写者并发：真 git 改 alpha、删 beta 并记录", async () => {
			await writeFile(
				join(ws.projectDir, "src", "alpha.ts"),
				'export const alpha = "v3 by git";\n',
				"utf8",
			);
			await git(ws, ["rm", "-q", "src/beta.ts"]);
			await git(ws, [
				"-c",
				"user.email=e2e@local",
				"-c",
				"user.name=e2e",
				"add",
				".",
			]);
			await git(ws, [
				"-c",
				"user.email=e2e@local",
				"-c",
				"user.name=e2e",
				"commit",
				"-q",
				"-m",
				"git writer: alpha v3, drop beta",
			]);
			const recorded = await cliJson<{ ok?: boolean; writer?: string }>(ws, [
				"sessions",
				"record",
				"--writer",
				"git-main",
				"--kind",
				"git",
				"--label",
				"git-main",
				"--activity",
				"commit",
				"--generated",
				"src/alpha.ts",
				"--generated",
				"src/beta.ts",
			]);
			return recorded;
		});

		await step("S4 等服务周期任务产出 premise_stale 与通知", async () => {
			// 只认「本线程」的失效事件：pending 里可能躺着前几轮未 ack 的
			// 队列项，而 reconcile 是 15s 一跳，轮内时序不能赌。
			await waitFor(
				"本线程的 premise_stale 事件",
				async () =>
					(await lastEventFor(ws, "premise_stale", threadId)) !== null,
				60_000,
			);
			return "premise_stale 已产出";
		});

		await step("S5 恢复线程：恢复卡事实/覆盖率/注记", async () => {
			await api(server, `/api/chat/threads/${threadId}/restore`, {
				method: "POST",
				body: JSON.stringify({ fromThreadId: null }),
			});
			const view = (await (
				await api(server, `/api/chat/threads/${threadId}`)
			).json()) as {
				resumeCard: {
					facts: Array<{ refs: string[]; source: string }>;
					coverage: { status: string; text: string };
					narrative: Array<{ text: string; refs: string[] }>;
					inject: boolean;
				} | null;
			};
			const card = view.resumeCard;
			if (!card) throw new Error("恢复卡未渲染");
			if (card.facts.length === 0) throw new Error("事实段为空");
			if (card.facts.some((f) => f.refs.length === 0)) {
				throw new Error("存在无 refs 的事实行");
			}
			if (card.coverage.status !== "available") {
				throw new Error(`覆盖率不可用：${card.coverage.status}`);
			}
			if (card.facts.every((f) => f.source !== "read-set")) {
				throw new Error("事实段没有读集行");
			}
			return {
				facts: card.facts.length,
				coverage: card.coverage.text,
			};
		});

		const forkChild = await step(
			"S6 分叉 + 子分支写 stale 文件（R10）",
			async () => {
				const messages = (await (
					await api(server, `/api/chat/threads/${threadId}`)
				).json()) as { messages: Array<{ id: string }> };
				const anchor = messages.messages.at(-1)?.id;
				if (!anchor) throw new Error("没有可分叉的锚点消息");
				const forkRes = await api(
					server,
					`/api/chat/threads/${threadId}/fork`,
					{
						method: "POST",
						body: JSON.stringify({ anchorMessageId: anchor }),
					},
				);
				const outcome = (await forkRes.json()) as { thread?: { id: string } };
				const childId = outcome.thread?.id;
				if (!childId) throw new Error("fork 未返回子线程");
				await sendTurn(
					server,
					childId,
					[
						"分支上继续。",
						"WRITE src/alpha.ts",
						'export const alpha = "v4 on branch";',
						"__END_WRITE__",
					].join("\n"),
				);
				const view = (await (
					await api(server, `/api/chat/threads/${threadId}`)
				).json()) as {
					resumeCard: {
						facts: Array<{
							source: string;
							refs: string[];
							annotation?: { rule: string };
							branch?: { threadId: string; paths: string[] };
						}>;
					} | null;
				};
				const branchRow = view.resumeCard?.facts.find(
					(f) => f.source === "branch",
				);
				if (!branchRow) throw new Error("R10 分支行未渲染");
				if (branchRow.annotation?.rule !== "R10")
					throw new Error("注记不是 R10");
				if (branchRow.branch?.threadId !== childId)
					throw new Error("分支指针错误");
				if (!branchRow.branch.paths.includes("src/alpha.ts")) {
					throw new Error("分支写集缺 src/alpha.ts");
				}
				if (branchRow.refs.length === 0) throw new Error("R10 行无事件引用");
				return {
					childId,
					paths: branchRow.branch.paths,
					refs: branchRow.refs.length,
				};
			},
		);

		await step("S6b 空分支零痕迹", async () => {
			const messages = (await (
				await api(server, `/api/chat/threads/${threadId}`)
			).json()) as { messages: Array<{ id: string }> };
			const anchor = messages.messages.at(-1)?.id;
			if (!anchor) throw new Error("没有可分叉的锚点消息");
			const forkRes = await api(server, `/api/chat/threads/${threadId}/fork`, {
				method: "POST",
				body: JSON.stringify({ anchorMessageId: anchor }),
			});
			if (!forkRes.ok) throw new Error(`空分支 fork 失败：${forkRes.status}`);
			const view = (await (
				await api(server, `/api/chat/threads/${threadId}`)
			).json()) as {
				resumeCard: {
					facts: Array<{ source: string; branch?: { threadId: string } }>;
				} | null;
			};
			const branchRows = (view.resumeCard?.facts ?? []).filter(
				(f) => f.source === "branch",
			);
			if (branchRows.length !== 1) {
				throw new Error(`空分支留下痕迹：${branchRows.length} 行分支事实`);
			}
			if (branchRows[0]?.branch?.threadId !== forkChild.childId) {
				throw new Error("留下的分支行不是写过的那个分支");
			}
			return `branch rows = ${branchRows.length}（空分支未产生行）`;
		});

		await step("S7 封印：hook 路径 block + 人工复核", async () => {
			// 封印以 hook 约定返回：阻断 = 退出 2 + stderr 阻断理由，JSON 在 stdout。
			const sealProc = await cli(ws, [
				"--json",
				"premises",
				"seal",
				"--target",
				"src/alpha.ts",
				"--writer",
				threadId,
			]);
			if (sealProc.code !== 0 && sealProc.code !== 2) {
				throw new Error(
					`seal 异常退出 ${sealProc.code}：${sealProc.stderr.slice(0, 200)}`,
				);
			}
			const seal = JSON.parse(
				sealProc.stdout.slice(sealProc.stdout.indexOf("{")),
			) as {
				blocked: boolean;
				decision: string;
				matchedDeclarations: string[];
			};
			if (!seal.blocked) throw new Error(`封印未阻断：${JSON.stringify(seal)}`);
			if (!seal.matchedDeclarations.includes("src/alpha.ts")) {
				throw new Error("阻断未命中 alpha 声明");
			}
			const sealEventId = await lastEventId(ws, "seal.decided");
			if (!sealEventId) throw new Error("seal.decided 事件无 id");
			const review = await cli(ws, [
				"premises",
				"review-seal",
				sealEventId,
				"--correct",
				"--reason",
				"集成验证：阻断命中的确是已失效前提",
			]);
			if (review.code !== 0) {
				throw new Error(`review-seal 失败：${review.stderr || review.stdout}`);
			}
			return { sealEventId, blocked: seal.blocked };
		});

		await step("S8 兴趣降低：观察 → lower → 不可见", async () => {
			const before = await cliJson<{
				visible: string[];
				reductions: { total: number };
			}>(ws, ["context", "list", "--writer", threadId]);
			if (!before.visible.includes("src/notes.md")) {
				throw new Error(`读集未进兴趣投影：${before.visible.join(",")}`);
			}
			const lower = await cliJson<{ recorded: boolean }>(ws, [
				"context",
				"lower",
				"src/notes.md",
				"--writer",
				threadId,
			]);
			if (!lower.recorded) throw new Error("lower 未记录");
			const after = await cliJson<{ visible: string[] }>(ws, [
				"context",
				"list",
				"--writer",
				threadId,
			]);
			if (after.visible.includes("src/notes.md")) {
				throw new Error("降低后仍然可见");
			}
			return { before: before.visible, after: after.visible };
		});

		await step("S9 dismiss 跨轮生效", async () => {
			await api(server, `/api/chat/threads/${threadId}/resume-note/dismiss`, {
				method: "POST",
			});
			const view = (await (
				await api(server, `/api/chat/threads/${threadId}`)
			).json()) as {
				resumeCardDismissed: boolean;
				resumeCard: { inject: boolean } | null;
			};
			if (!view.resumeCardDismissed) throw new Error("dismiss 未落状态");
			if (view.resumeCard?.inject !== false)
				throw new Error("dismiss 后仍注入");
			return "dismiss 生效";
		});

		const statsSummary = await step("S10 stats --json 护城河数字", async () => {
			const stats = await cliJson<{
				threads?: { total?: number };
				lifecycle?: { restores?: number };
				seal?: { decisions?: number; blocked?: number };
				noticeOutcomes?: { rows?: number };
				premises?: { overlaps?: number; notified?: number };
			}>(ws, ["stats"]);
			const summary = {
				threads: stats.threads?.total,
				restores: stats.lifecycle?.restores,
				sealDecisions: stats.seal?.decisions,
				sealBlocked: stats.seal?.blocked,
				noticeOutcomeRows: stats.noticeOutcomes?.rows,
				overlaps: stats.premises?.overlaps,
				notified: stats.premises?.notified,
			};
			for (const [key, value] of Object.entries(summary)) {
				if (!value || (typeof value === "number" && value < 1)) {
					throw new Error(`stats.${key} 为空（${JSON.stringify(summary)}）`);
				}
			}
			return summary;
		});

		await step("S11 fit 账本对租户黑板输出 t0 与样本窗口", async () => {
			const parsed = await new Promise<{
				t0?: { started: boolean; threads: number; writers: number };
				sampleWindow?: Record<string, unknown>;
			}>((done, fail) => {
				const proc = spawn(
					execPath,
					[resolve(import.meta.dir, "..", "fit-ledger.ts"), "--json"],
					{ cwd: ws.projectDir, env: { ...process.env } },
				);
				let out = "";
				proc.stdout.on("data", (chunk) => (out += String(chunk)));
				proc.stderr.on("data", (chunk) => (out += String(chunk)));
				proc.on("exit", (code) =>
					code === 0
						? done(JSON.parse(out.slice(out.indexOf("{"))))
						: fail(new Error(`fit-ledger 退出 ${code}：${out.slice(0, 400)}`)),
				);
				proc.on("error", fail);
			});
			if (!parsed.t0?.started) throw new Error("t0 未被判据点亮");
			report.ledgerT0 = parsed.t0 ?? null;
			report.sampleWindow = parsed.sampleWindow ?? null;
			return parsed;
		});

		report.stats = statsSummary as unknown as Record<string, unknown>;
		report.ok = true;
	} finally {
		await server.stop();
		if (!options.keepWorkspace) {
			await rm(ws.projectDir, { recursive: true, force: true }).catch(() => {});
		}
	}
	return report;
}
