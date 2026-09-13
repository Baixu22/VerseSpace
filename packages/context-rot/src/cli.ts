/**
 * context-rot doctor — 一条命令检测 agent 指引文件里已失效的代码引用。
 *
 * 用法：
 *   context-rot [root] [--json] [--help]
 *
 * 退出码：0 = 无失效引用；1 = 发现失效引用；2 = 没有可扫描的指引文件。
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { type ScanResult, type StaleRef, scanRepo } from "./scan.ts";

const HELP = `context-rot — 检测 AGENTS.md / CLAUDE.md / .cursorrules 中已失效的代码引用

用法：
  context-rot [目录]            默认扫描当前目录
  context-rot --json            机器可读输出
  context-rot install-hooks     一条命令接入足迹采集（复制脚本 + 合并 .claude/settings.json）
  context-rot install-hooks --uninstall
  context-rot --help            本帮助

零配置、零 agent、即时输出。退出码：0 无失效，1 有失效，2 无指引文件。`;

/**
 * install-hooks 子命令：转发给包内 scripts/install-hooks.mjs（安装逻辑的唯一来源）。
 * npm 包结构固定为 <pkg>/dist/cli.js + <pkg>/scripts/install-hooks.mjs，
 * 运行时通过 import.meta.url 回溯包根，保证 npx 场景也能定位。
 */
function runInstallHooks(args: string[]): number {
	const installer = fileURLToPath(
		new URL("../scripts/install-hooks.mjs", import.meta.url),
	);
	try {
		execFileSync(process.execPath, [installer, ...args], { stdio: "inherit" });
		return 0;
	} catch (err) {
		const code = (err as { status?: number }).status;
		if (typeof code === "number") return code;
		console.error(`install-hooks 执行失败（${(err as Error).message}）`);
		return 1;
	}
}

export function formatHuman(result: ScanResult): string {
	const lines: string[] = [];
	const docList = result.docs.length > 0 ? result.docs.join(", ") : "无";
	lines.push(`扫描 ${result.docs.length} 个指引文件：${docList}`);
	const unverifiedNote =
		result.unverified > 0 ? `   ⚠ 未能判定 ${result.unverified} 条` : "";
	const generatedNote =
		result.generated > 0 ? `   ⚙ 生成物 ${result.generated} 条不计入` : "";
	lines.push(
		`架构断言：${result.total} 条   ✔ 有效 ${result.valid} 条   ✘ 已失效 ${result.stale.length} 条${generatedNote}${unverifiedNote}`,
	);
	if (result.stale.length > 0) {
		lines.push("");
		lines.push("✘ 已失效引用：");
		for (const ref of result.stale) {
			lines.push(`  ${ref.doc}:${ref.line}  \`${ref.text}\`  ${ref.reason}`);
		}
	}
	lines.push("");
	lines.push(`完成，用时 ${result.durationMs}ms`);
	return lines.join("\n");
}

export function formatJson(result: ScanResult): string {
	return JSON.stringify(
		{
			root: result.root,
			docs: result.docs,
			totalAssertions: result.total,
			valid: result.valid,
			generated: result.generated,
			unverified: result.unverified,
			stale: result.stale.map((ref: StaleRef) => ({
				doc: ref.doc,
				line: ref.line,
				kind: ref.kind,
				text: ref.text,
				reason: ref.reason,
			})),
			durationMs: result.durationMs,
		},
		null,
		2,
	);
}

export async function main(argv: string[]): Promise<number> {
	// 子命令优先：install-hooks 不扫描（含 --help 也透传给安装器）
	const sub = argv.find((a) => !a.startsWith("--"));
	if (sub === "install-hooks") {
		const rest = argv.filter((a) => a !== "install-hooks");
		return runInstallHooks(rest);
	}

	if (argv.includes("--help") || argv.includes("-h")) {
		console.log(HELP);
		return 0;
	}

	const positional = argv.filter((a) => !a.startsWith("--"));
	const root = positional[0] ?? process.cwd();

	const result = await scanRepo(root);

	if (argv.includes("--json")) {
		console.log(formatJson(result));
	} else {
		console.log(formatHuman(result));
	}

	if (result.docs.length === 0) {
		console.error("未找到任何指引文件（AGENTS.md / CLAUDE.md / .cursorrules）");
		return 2;
	}
	return result.stale.length > 0 ? 1 : 0;
}

// 直跑入口：bun src/cli.ts / 编译后的 dist/cli.js
if (import.meta.main) {
	process.exitCode = await main(process.argv.slice(2));
}
