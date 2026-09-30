/** Opt-in remote-model E2E. Always creates a new isolated workspace. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runLiveDevelopment } from "./live-development";
import { runLiveFork } from "./live-fork";
import { liveProtocol } from "./live-wire";
import { type E2EReport, makeTempWorkspace, runE2E } from "./scenario";

if (!process.env.E2E_LLM_KEY || !process.env.E2E_LLM_MODEL)
	throw new Error("需要 E2E_LLM_KEY 和 E2E_LLM_MODEL；密钥只通过环境变量传入");
const ws = await makeTempWorkspace();
ws.agentScript = resolve(import.meta.dir, "live-agent.ts");
await mkdir(join(ws.projectDir, "runs"), { recursive: true });
await writeFile(
	join(ws.projectDir, ".live-e2e-authorized"),
	"isolated-live-model-fixture\n",
);
console.log(`[live] 隔离工作区：${ws.projectDir}`);
let report: E2EReport | { ok: false; error: string } = {
	ok: false,
	error: "集成场景尚未完成",
};
let development: Awaited<ReturnType<typeof runLiveDevelopment>> | undefined;
let forks: Awaited<ReturnType<typeof runLiveFork>> | undefined;
try {
	report = await runE2E(ws, { keepWorkspace: true });
	await writeFile(
		join(ws.projectDir, "runs/live-integration.json"),
		`${JSON.stringify(report, null, 2)}\n`,
	);
	development = await runLiveDevelopment(ws);
	forks = await runLiveFork(ws);
} catch (error) {
	report = {
		...report,
		ok: false,
		error: String(error).split(process.env.E2E_LLM_KEY).join("[REDACTED]"),
	};
	process.exitCode = 1;
}
const calls = (
	await readFile(
		join(ws.projectDir, ".workbench/live-agent/calls.jsonl"),
		"utf8",
	).catch(() => "")
)
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));
const attempts = (
	await readFile(
		join(ws.projectDir, ".workbench/live-agent/attempts.jsonl"),
		"utf8",
	).catch(() => "")
)
	.trim()
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));
const evidence = {
	source: "live-model-scripted-scenario",
	model: process.env.E2E_LLM_MODEL,
	transport: `${liveProtocol(process.env.E2E_LLM_BASE_URL ?? "https://api.senseaudio.cn/v1")} HTTP + stream-json 工具观测；另测 Workbench 原生 HTTP SSE`,
	limitations:
		"模型回复与工具是真实执行；恢复手势、human/git 写者和复核操作由测试脚本驱动，不代表人工偏好或自然用户体验。",
	...report,
	development,
	forks,
	calls,
	attempts,
};
const path = join(ws.projectDir, "runs/live-report.json");
await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(
	`[live] ${report.ok ? "通过" : "失败"}；模型响应 ${calls.length} 次；请求尝试 ${attempts.length} 次；报告 ${path}`,
);
if (!report.ok) console.error("error" in report ? report.error : "场景未通过");
