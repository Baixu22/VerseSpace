/** Opt-in real-model verification of the public batch CLI (issue #11). */
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentSession } from "../../src/agents/runner";
import { openBlackboard } from "../../src/blackboard";
import { hashText } from "../../src/hash";
import { drainPremiseQueue } from "../../src/runtime/delivery";
import { reconcilePremises } from "../../src/runtime/premises";
import { spawnSupervised } from "../../src/supervisor";
import { workbenchConfigSchema } from "../../src/types/config";
import { seedProject } from "./fixtures";
import { loadLiveModelCredentials } from "./live-credentials";

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	assert(args.includes("--run-live"), "真实模型验证必须显式传 --run-live");
	const outAt = args.indexOf("--out");
	const output = resolve(
		outAt < 0 ? ".evidence-sites" : (args[outAt + 1] ?? ""),
	);
	const nativeClaude = args.includes("--claude");
	const credentials = nativeClaude ? undefined : loadLiveModelCredentials();
	await mkdir(output, { recursive: true });
	const root = await mkdtemp(join(output, "agent-run-live-"));
	const entry = resolve(import.meta.dir, "../../src/index.ts");
	const ws = {
		projectDir: root,
		entry,
		agentScript: resolve(import.meta.dir, "live-agent.ts"),
	};
	console.log(`[agent-live] 隔离现场：${root}`);
	const report: Record<string, unknown> = {
		ok: false,
		source: "live-model-scripted-scenario",
		provider: nativeClaude ? "claude-code" : "openai-compatible-live-adapter",
		model: credentials?.model,
		baseUrl: credentials?.baseUrl,
		credentialOrigin: credentials?.origin ?? "claude-code-login",
		workspace: root,
		startedAt: new Date().toISOString(),
		limitations: [
			"模型工具实际执行，任务和通知转发由验证脚本安排；不代表自然使用或真人认可。",
			"通知由本验证宿主通过下一次 agent run 的 prompt 转发；未声称批处理有常驻推送通道。",
			"批处理会话和原始模型流保存在 agents/；不创建 GUI chat thread。",
		],
	};
	const commands: Array<{ args: string[]; exitCode: number | null }> = [];
	async function cli<T>(commandArgs: string[]): Promise<T> {
		const lines: string[] = [];
		const errors: string[] = [];
		const proc = spawnSupervised(
			[process.execPath, entry, "--json", ...commandArgs],
			{
				label: "agent-live-cli",
				cwd: root,
				timeoutSeconds: 240,
				env: {
					...process.env,
					E2E_HOP_TIMEOUT_MS: "60000",
					E2E_LLM_MAX_HOPS: "6",
				},
				onLine: (line, kind) => (kind === "out" ? lines : errors).push(line),
			},
		);
		const outcome = await proc.wait();
		commands.push({ args: commandArgs, exitCode: outcome.exitCode });
		assert.equal(outcome.exitCode, 0, outcome.error ?? errors.join("\n"));
		return JSON.parse(lines.join("\n")) as T;
	}
	try {
		await seedProject(ws);
		await writeFile(
			join(root, ".live-e2e-authorized"),
			"isolated-live-model-fixture\n",
		);
		const goal = await cli<{ id: string }>([
			"goal",
			"add",
			"真实批处理读写验证",
		]);
		for (const id of ["reader", "writer"]) {
			await cli([
				"ws",
				"create",
				id,
				"--task",
				goal.id,
				"--branch",
				id,
				"--worktree",
				".",
			]);
		}
		const agentCommand = nativeClaude
			? `${workbenchConfigSchema.parse({}).agent.command} --safe-mode --strict-mcp-config --tools Read,Write --allowedTools Read,Write`
			: `"${process.execPath}" "${resolve(import.meta.dir, "agent-run-live.ts")}"`;
		await cli(["config", "set", "agent.command", agentCommand]);
		const bb = openBlackboard(join(root, ".workbench"));
		const sessions: AgentSession[] = [];
		const modelSessionIds: string[] = [];
		async function run(workspot: string, prompt: string): Promise<void> {
			if (nativeClaude)
				prompt = [
					"只操作当前隔离工程的 src/ 文件。READ 表示实际读取；WRITE 后到 __END_WRITE__ 是要逐字写入的内容，末尾加换行。按顺序执行所有指令，最后简短报告。",
					prompt,
				].join("\n");
			console.log(
				`[agent-live] 开始 ${workspot}，第 ${sessions.length + 1} 个真实回合`,
			);
			const result = await cli<{ ok: boolean; logFile: string }>([
				"agent",
				"run",
				"--workspot",
				workspot,
				"--prompt",
				prompt,
			]);
			assert.equal(result.ok, true);
			const session = JSON.parse(
				await readFile(
					join(root, ".workbench", "agents", workspot, "latest.json"),
					"utf8",
				),
			) as AgentSession;
			assert.equal(session.status, "done", session.error);
			assert.equal(session.exitCode, 0, session.error);
			const events = (await readFile(result.logFile, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind: string; line: string })
				.filter((line) => line.kind === "out")
				.map((line) => JSON.parse(line.line) as Record<string, unknown>);
			assert(
				events.some(
					(event) => event.type === "result" && event.subtype === "success",
				),
			);
			assert(!events.some((event) => event.is_error === true));
			const init = events.find(
				(event) => event.type === "system" && event.subtype === "init",
			);
			assert.equal(typeof init?.session_id, "string");
			modelSessionIds.push(String(init?.session_id));
			report.model ??= init?.model;
			sessions.push(session);
		}
		await run(
			"reader",
			[
				"先实际读取 alpha，再写入指定输出，两个工具都必须调用。",
				"READ src/alpha.ts",
				"WRITE src/read-result.txt",
				"observed v1",
				"__END_WRITE__",
			].join("\n"),
		);
		let footprint = await bb.sessions.footprint("agent:reader");
		assert(
			footprint.some((line) =>
				line.used.some(
					(claim) =>
						claim.path === "src/alpha.ts" &&
						claim.version === hashText('export const alpha = "v1";\n'),
				),
			),
		);
		assert(
			footprint.some((line) =>
				line.generated.some(
					(claim) =>
						claim.path === "src/read-result.txt" &&
						typeof claim.version === "string",
				),
			),
		);
		await run(
			"writer",
			[
				"WRITE src/alpha.ts",
				'export const alpha = "v2";',
				"__END_WRITE__",
			].join("\n"),
		);
		assert.equal(
			(await readFile(join(root, "src/alpha.ts"), "utf8")).trim(),
			'export const alpha = "v2";',
		);
		const stale = await reconcilePremises(bb);
		assert(stale.some((notice) => notice.writerId === "agent:reader"));
		const delivery = await drainPremiseQueue(bb, {
			deliver: async (writer, message) => {
				if (writer !== "agent:reader") return false;
				await run(
					"reader",
					[
						message,
						"必须重新读取变更文件，再更新输出。",
						"READ src/alpha.ts",
						"WRITE src/read-result.txt",
						"observed v2",
						"__END_WRITE__",
					].join("\n"),
				);
				return true;
			},
		});
		assert.equal(delivery.delivered.length, 1);
		footprint = await bb.sessions.footprint("agent:reader");
		const reads = footprint
			.flatMap((line) => line.used)
			.filter((claim) => claim.path === "src/alpha.ts");
		assert.equal(
			reads.at(-1)?.version,
			hashText(await readFile(join(root, "src/alpha.ts"), "utf8")),
		);
		assert.equal(
			(await readFile(join(root, "src/read-result.txt"), "utf8")).trim(),
			"observed v2",
		);
		assert(
			!(await reconcilePremises(bb)).some(
				(notice) => notice.writerId === "agent:reader",
			),
		);
		const writers = await bb.sessions.list();
		assert(writers.every((writer) => writer.kind === "agent"));
		const events = await bb.events.all();
		assert.equal(new Set(modelSessionIds).size, sessions.length);
		if (!nativeClaude) {
			const historyDir = join(root, ".workbench", "live-agent");
			const histories = (await readdir(historyDir)).filter((name) =>
				name.endsWith(".json"),
			);
			assert.equal(histories.length, sessions.length);
			const calls = (await readFile(join(historyDir, "calls.jsonl"), "utf8"))
				.trim()
				.split("\n");
			assert(calls.length >= sessions.length);
			report.modelSessionFiles = histories;
			report.modelCalls = calls.length;
		}
		Object.assign(report, {
			ok: true,
			sessions,
			writers,
			modelSessionIds,
			footprint,
			chain: {
				stale: stale.length,
				delivered: delivery.delivered.length,
				repaired: true,
				footprintEvents: events.filter((event) => event.type === "footprint")
					.length,
				started: events.filter((event) => event.type === "agent_started")
					.length,
				finished: events.filter((event) => event.type === "agent_finished")
					.length,
			},
		});
	} catch (error) {
		report.error = credentials
			? String(error).split(credentials.key).join("[REDACTED]")
			: String(error);
		process.exitCode = 1;
	} finally {
		report.commands = commands;
		report.finishedAt = new Date().toISOString();
		const file = join(root, "report.json");
		await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
		console.log(`[agent-live] ${report.ok ? "通过" : "失败"}：${file}`);
		if (!report.ok) console.error(report.error);
	}
}

if (import.meta.main) await main();
