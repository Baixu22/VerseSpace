/**
 * 数据监控 + 真实样本累积 的统一入口（宿主无关版，等价于原来的 monitor.ps1）。
 *
 * 为什么两者放一起：样本只有在真实租户里才有意义，而租户只在持续采样时才长得出可判的
 * 数字。等一个月的日常使用会把每个问题都推迟一个月；这里每批结束都出一份差分报告，
 * 于是「阈值掉了、计数器倒退了、报告与账本不一致」当天就看得见。
 *
 * 用法（任何能起 bun 的地方都能跑：终端、Git Bash、CI；凭据由 `live-credentials.ts` 取
 * ——环境变量 `E2E_LLM_KEY` 优先，否则用 bun:ffi 解 DPAPI，密钥不进命令行、不落盘、不打印）：
 *   bun scripts/e2e/monitor.ts                              # 只监控（只读，不需要凭据）
 *   bun scripts/e2e/monitor.ts --rounds 3                   # 先跑 3 轮 live，再出监控报告
 *   bun scripts/e2e/monitor.ts --rounds 3 --out docs/fit-monitor.md --fail-on warn
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadLiveModelCredentials } from "./live-credentials";

const here = import.meta.dir;
const argv = process.argv.slice(2);
const at = (flag: string): string | undefined => {
	const index = argv.indexOf(flag);
	return index >= 0 ? argv[index + 1] : undefined;
};

const rounds = Math.max(0, Number(at("--rounds") ?? "0"));
const workspace = resolve(
	at("--workspace") ?? join(tmpdir(), "workbench-e2e-live-tenant"),
);
const out = at("--out");
const failOn = at("--fail-on") ?? "high";
const evidenceKind = at("--evidence-kind") ?? "live-model";

async function run(
	args: string[],
	env: Record<string, string | undefined> = process.env,
): Promise<number> {
	const child = spawn(process.execPath, args, {
		cwd: resolve(here, "..", ".."),
		env,
		stdio: "inherit",
	});
	return await new Promise<number>((done, fail) => {
		child.on("exit", (code) => done(code ?? -1));
		child.on("error", fail);
	});
}

let exitCode = 0;

if (rounds > 0) {
	const credentials = loadLiveModelCredentials();
	const historyPath = join(workspace, "runs", "history.jsonl");
	const done = (await readFile(historyPath, "utf8").catch(() => ""))
		.trim()
		.split("\n")
		.filter(Boolean).length;
	console.log(
		`[monitor] model ${credentials.model} - endpoint ${credentials.baseUrl} - tenant ${workspace} - appending ${rounds} round(s) from index ${done + 1}`,
	);
	const code = await run(
		[
			resolve(here, "run.ts"),
			"--live",
			"--rounds",
			String(rounds),
			"--start-round",
			String(done + 1),
			"--workspace",
			workspace,
		],
		{
			...process.env,
			E2E_LLM_KEY: credentials.key,
			E2E_LLM_MODEL: credentials.model,
			E2E_LLM_BASE_URL: credentials.baseUrl,
		},
	);
	if (code !== 0) {
		console.log(
			`[monitor] the sampling batch had failing rounds; tenant kept at ${join(workspace, "runs")}`,
		);
		exitCode = 1;
	}
}

const monitorArgs = [
	resolve(here, "..", "fit-monitor.ts"),
	"--workspace",
	workspace,
	"--evidence-kind",
	evidenceKind,
	"--fail-on",
	failOn,
];
if (out) monitorArgs.push("--out", out);
if (argv.includes("--json")) monitorArgs.push("--json");
if (argv.includes("--no-append")) monitorArgs.push("--no-append");
const monitorCode = await run(monitorArgs);
if (monitorCode !== 0) exitCode = monitorCode;

process.exit(exitCode);
