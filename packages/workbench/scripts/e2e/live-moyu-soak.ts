/**
 * moyu 长期累积跑（TF-0163）：在**同一个持久现场**上反复跑真实开发回合，让护城河 A
 * （校准表行数）在同一块黑板上累积。
 *
 * 为什么必须同一现场：A 的读数来自单一黑板（ctx.stats），多个落盘现场各算各的，行数
 * 不会自然相加——这是 TF-0163 在 2026-09-12 确认的结构性缺口。所以累积的唯一诚实做法
 * 就是「同一现场、多轮」，而不是把单轮做大或把不同现场的行数加起来。
 *
 * 每轮做三件事：
 *   ① 跑一个真实开发回合 + 三条分叉（live-moyu-run.ts，工作对象是真实仓库 moyu 的
 *      校验模块，不是合成 fixture）；
 *   ② 用 fit-ledger 量这个现场的账本（护城河四数字 + 样本窗口 + 闸门）；
 *   ③ 把读数追加到 `<现场>/runs/history.jsonl`——这是「累积入口可复现、读数不用手算」
 *      的落点；同时把子进程输出追加到 `<现场>/runs/soak-log.txt`，便于长跑时观察。
 *
 * 红线（写在代码里，别绕过）：不伪造自然使用日期；不把脚本/模型安排的手势记成真人
 * 认可（本驱动不写任何 landmark.review，L1 复核仍留给真人）；不为凑行数放宽判据。
 *
 * 用法（凭据只走环境变量，别写进命令历史）：
 *   E2E_MOYU_LABEL=moyu-soak E2E_MOYU_ROUNDS=5 bun scripts/e2e/live-moyu-soak.ts
 * 或经 run-live.ps1 的 -MoyuSoakLabel / -MoyuSoakRounds（由它从 DPAPI 载入凭据）。
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const WORKBENCH = resolve(import.meta.dir, "..", "..");
const label = process.env.E2E_MOYU_LABEL ?? "moyu-soak";
const rounds = Math.max(1, Number(process.env.E2E_MOYU_ROUNDS ?? "1"));
const maxConsecutiveFailures = Math.max(
	1,
	Number(process.env.E2E_MOYU_MAX_FAILURES ?? "3"),
);

if (!process.env.E2E_LLM_KEY || !process.env.E2E_LLM_MODEL)
	throw new Error("需要 E2E_LLM_KEY 和 E2E_LLM_MODEL；密钥只通过环境变量传入");

const site = join(WORKBENCH, ".evidence-sites", `live-moyu-${label}`);
const runsDir = join(site, "runs");
const historyPath = join(runsDir, "history.jsonl");
const logPath = join(runsDir, "soak-log.txt");
const moyuRunner = resolve(import.meta.dir, "live-moyu-run.ts");
const ledgerScript = resolve(import.meta.dir, "..", "fit-ledger.ts");

await mkdir(runsDir, { recursive: true });

// 轮次编号接着历史往下排：同一现场可以被多次调用，编号不能从 1 重来，
// 否则报告互相覆盖、history.jsonl 也读不出一条单调的 A 序列。
const priorRounds = (await readFile(historyPath, "utf8").catch(() => ""))
	.trim()
	.split("\n")
	.filter(Boolean).length;
const startRound = Number(
	process.env.E2E_MOYU_ROUND_START ?? String(priorRounds + 1),
);

async function log(line: string): Promise<void> {
	const stamped = `[${new Date().toISOString()}] ${line}`;
	console.log(stamped);
	await appendFile(logPath, `${stamped}\n`, "utf8");
}

interface LedgerReading {
	sampleWindow?: {
		satisfied: boolean;
		missing: string[];
		restores: number;
		noticeOutcomes: number;
		sealDecisions: number;
	};
	moat?: Array<{ key: string; name: string; value: unknown; present: boolean }>;
	gate?: { open: boolean; missing: string[] };
}

/** 量这个现场的账本；账本本身不可用时返回 null（不要把失败读成 0）。 */
async function readLedger(): Promise<LedgerReading | null> {
	// 与 run.ts 的租户账本汇总用同一套调用（Bun.spawnSync + --evidence-kind）。
	const proc = Bun.spawnSync(
		[process.execPath, ledgerScript, "--json", "--evidence-kind", "live-model"],
		{ cwd: site },
	);
	const stdout = new TextDecoder().decode(proc.stdout);
	const start = stdout.indexOf("{");
	if (proc.exitCode !== 0 || start < 0) {
		await log(
			`账本读取失败（exit=${proc.exitCode}）：${new TextDecoder().decode(proc.stderr).slice(0, 200)}`,
		);
		return null;
	}
	return JSON.parse(stdout.slice(start)) as LedgerReading;
}

async function runRound(round: number): Promise<number> {
	const child = spawn(process.execPath, [moyuRunner], {
		cwd: WORKBENCH,
		env: {
			...process.env,
			E2E_MOYU_LABEL: label,
			E2E_MOYU_ROUND: String(round),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk) => (output += String(chunk)));
	child.stderr.on("data", (chunk) => (output += String(chunk)));
	const code = await new Promise<number>((done, fail) => {
		child.on("exit", (exitCode) => done(exitCode ?? -1));
		child.on("error", fail);
	});
	await appendFile(logPath, output, "utf8");
	return code;
}

await log(
	`累积跑开始：现场 ${site}；轮次 ${startRound}–${startRound + rounds - 1}；模型 ${process.env.E2E_LLM_MODEL}；连续失败上限 ${maxConsecutiveFailures}`,
);

let consecutiveFailures = 0;
let completed = 0;
for (let index = 0; index < rounds; index += 1) {
	const round = startRound + index;
	await log(`===== 第 ${round} 轮（本批 ${index + 1}/${rounds}）=====`);
	const startedAt = new Date().toISOString();
	const code = await runRound(round);
	const ledger = await readLedger();
	const reading = {
		at: startedAt,
		round,
		ok: code === 0,
		sampleWindow: ledger?.sampleWindow ?? null,
		moat: Object.fromEntries(
			(ledger?.moat ?? []).map((item) => [item.key, item.value]),
		),
		gate: ledger?.gate ?? null,
	};
	await appendFile(historyPath, `${JSON.stringify(reading)}\n`, "utf8");
	await log(
		`第 ${round} 轮 ${code === 0 ? "通过" : `失败（exit=${code}）`}；` +
			`护城河 A=${JSON.stringify(reading.moat.A ?? null)} ` +
			`B=${JSON.stringify(reading.moat.B ?? null)} ` +
			`C=${JSON.stringify(reading.moat.C ?? null)} ` +
			`D=${JSON.stringify(reading.moat.D ?? null)}；` +
			`样本窗口=${JSON.stringify(reading.sampleWindow)}；` +
			`闸门=${reading.gate?.open ? "开" : `关（缺 ${reading.gate?.missing?.join("、") ?? "?"}）`}`,
	);
	completed += 1;
	if (code === 0) {
		consecutiveFailures = 0;
	} else {
		consecutiveFailures += 1;
		if (consecutiveFailures >= maxConsecutiveFailures) {
			await log(
				`连续 ${consecutiveFailures} 轮失败，停止累积（不要用失败轮次凑样本）`,
			);
			break;
		}
	}
}

// 收尾：把 A 的序列打出来，单调性是这一轮的验收读数。
const history = (await readFile(historyPath, "utf8"))
	.trim()
	.split("\n")
	.filter(Boolean)
	.map(
		(line) =>
			JSON.parse(line) as { round: number; moat: Record<string, unknown> },
	);
const aSeries = history.map((row) => Number(row.moat.A ?? 0));
const monotonic = aSeries.every(
	(value, index) => index === 0 || value >= (aSeries[index - 1] ?? 0),
);
await log(
	`累积跑结束：完成 ${completed}/${rounds} 轮；A 序列 ${JSON.stringify(aSeries)}；单调不减=${monotonic ? "是" : "否"}`,
);
if (!monotonic) process.exitCode = 1;
