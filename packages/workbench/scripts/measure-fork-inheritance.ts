/**
 * TF-0140 · Claude 上下文继承三问实验
 *
 * 背景：threads.ts 在 fork 时拼 `--resume <sourceSessionId> --fork-session`，
 * 并预留了 footprint.inherited / ForkAgentPlan.sourceFootprintSeq，但这些字段
 * 至今没有合法写入点。本脚本把「三选一继承语义」窄化成三个可测问题：
 *
 *   Q1  `claude -p --input-format stream-json` 铸出的 session id，
 *       能不能被 `--resume <id> --fork-session` 接上？接上后是新 id 还是原 id？
 *   Q2  fork 后第一轮的 usage.cache_read_input_tokens 是否约等于源会话前缀长度
 *       （即前缀 KV 命中）？
 *   Q3  fork 后新会话的 tool_use_id 能不能和源会话足迹 join（命名空间是否重置）？
 *
 * 两种模式，都只读真实数据，不构造假样本：
 *
 *   --scan（默认）  扫 ~/.claude/projects/ 下的真实会话，用「逐字前缀共享」
 *                   识别 fork 家族，在共享前缀上比对 tool_use_id 序列（Q3），
 *                   并输出分叉首轮的 cache 数字与时间间隔（Q2 及其混淆项）。
 *                   默认排除 --live 自己造的 scratch 会话，`--include-probe` 可保留。
 *   --live          真跑一次：铸一个源会话，再 `--resume … --fork-session`，
 *                   报告两个 session id 与磁盘上的前缀复刻情况（Q1，兼 Q3 直证）。
 *
 * 结论见 docs/report-2026-09-05-claude-fork-inheritance.md 与 ADR-0010 §5。
 *
 * 用法：
 *   bun run scripts/measure-fork-inheritance.ts
 *   bun run scripts/measure-fork-inheritance.ts --live
 *   bun run scripts/measure-fork-inheritance.ts --json out.json
 */

import { writeFile } from "node:fs/promises";
import { live } from "./fork-inheritance/live";
import { reportScan, scanPairs } from "./fork-inheritance/scan";

async function main(): Promise<void> {
	const argv = Bun.argv.slice(2);
	if (argv.includes("--live")) {
		await live();
		return;
	}
	const pairs = await scanPairs(argv.includes("--include-probe"));
	const jsonAt = argv.indexOf("--json");
	const jsonPath = jsonAt >= 0 ? argv[jsonAt + 1] : undefined;
	if (jsonPath) {
		await writeFile(jsonPath, `${JSON.stringify(pairs, null, 2)}\n`);
		console.log(`wrote ${jsonPath}`);
	}
	reportScan(pairs);
}

await main();
