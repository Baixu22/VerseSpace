/**
 * live E2E 统一入口（宿主无关）。
 *
 * 为什么要有它：本机的凭据此前只能由脚本宿主解密，于是「跑 live E2E」被绑死在那个宿主上；
 * 而某些宿主会话不执行原生进程（2026-09-12 实测），结果就是要么跑不起来、要么把明文密钥
 * 塞进命令行。这里把凭据读取收进 `live-credentials.ts`（env 优先，否则用 bun:ffi 解 DPAPI），
 * 于是**任何能起 bun 的地方**都能跑完整链路：bash、终端、CI，都不需要脚本宿主。
 *
 * 密钥只在进程内存里流转：不进命令行、不落盘、不打印（`check` 只报来源与长度）。
 *
 * 用法：
 *   bun scripts/e2e/live-entry.ts check
 *   bun scripts/e2e/live-entry.ts development <workspace>   # 真实开发回合 + 分叉
 *   bun scripts/e2e/live-entry.ts scenario                  # 新 TEMP 现场的集成场景
 *   bun scripts/e2e/live-entry.ts moyu <label>              # moyu 单轮（真实仓库）
 *   bun scripts/e2e/live-entry.ts moyu-soak <label> [rounds]  # moyu 累积跑（同一现场多轮）
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { loadLiveModelCredentials } from "./live-credentials";

const [mode, ...rest] = process.argv.slice(2);
const here = import.meta.dir;

function usage(): never {
	console.error(
		[
			"用法：live-entry.ts <mode> [args]",
			"  check",
			"  development <workspace>",
			"  scenario",
			"  moyu <label>",
			"  moyu-soak <label> [rounds]",
		].join("\n"),
	);
	process.exit(2);
}

async function run(
	script: string,
	extraArgs: string[],
	extraEnv: Record<string, string> = {},
): Promise<number> {
	const child = spawn(process.execPath, [resolve(here, script), ...extraArgs], {
		cwd: resolve(here, "..", ".."),
		env: {
			...process.env,
			E2E_LLM_KEY: credentials.key,
			E2E_LLM_MODEL: credentials.model,
			E2E_LLM_BASE_URL: credentials.baseUrl,
			...extraEnv,
		},
		stdio: "inherit",
	});
	return await new Promise<number>((done, fail) => {
		child.on("exit", (code) => done(code ?? -1));
		child.on("error", fail);
	});
}

const credentials = loadLiveModelCredentials({ require: mode === "check" });

if (mode === "check") {
	console.log(
		`凭据来源：${credentials.origin}；长度 ${credentials.key.length}；模型 ${credentials.model}；base ${credentials.baseUrl}`,
	);
	process.exit(credentials.key ? 0 : 1);
}

if (!credentials.key)
	throw new Error("没有可用的 live 模型凭据（E2E_LLM_KEY 或 DPAPI 文件）");

let code = 0;
if (mode === "development") {
	const workspace = rest[0];
	if (!workspace) usage();
	code = await run("live-development.ts", [workspace]);
	if (code === 0) code = await run("live-fork.ts", [workspace]);
} else if (mode === "fork") {
	const workspace = rest[0];
	if (!workspace) usage();
	code = await run("live-fork.ts", [workspace]);
} else if (mode === "scenario") {
	code = await run("live-run.ts", []);
} else if (mode === "moyu") {
	const label = rest[0];
	if (!label) usage();
	code = await run("live-moyu-run.ts", [], { E2E_MOYU_LABEL: label });
} else if (mode === "moyu-soak") {
	const label = rest[0];
	if (!label) usage();
	const rounds = rest[1] ?? "1";
	code = await run("live-moyu-soak.ts", [], {
		E2E_MOYU_LABEL: label,
		E2E_MOYU_ROUNDS: rounds,
	});
} else {
	usage();
}

process.exit(code);
