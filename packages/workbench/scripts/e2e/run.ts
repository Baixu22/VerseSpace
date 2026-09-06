/**
 * 租户累积跑：把 E2E 场景对一个持久工作区反复执行，让真实进程样本
 * 跨跑次累积——样本窗口（restore/notice/seal）与护城河四数字由此凑齐，
 * 这是 2026-09-06 用户决策的样本源（agent 驱动的真实集成跑，替代人工日用）。
 *
 * 用法：
 *   bun scripts/e2e/run.ts                        # 默认租户跑一轮
 *   bun scripts/e2e/run.ts --rounds 6             # 连续跑 6 轮（样本累积）
 *   bun scripts/e2e/run.ts --fresh                # 清空工作区后重新开始
 *   bun scripts/e2e/run.ts --workspace <dir>
 *   E2E_LLM_KEY=... E2E_LLM_MODEL=... bun run.ts  # 每轮附带真 LLM 回合
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type E2EReport, type E2EWorkspace, runE2E } from "./scenario";

const argv = Bun.argv.slice(2);
const at = (flag: string): string | undefined => {
	const index = argv.indexOf(flag);
	return index >= 0 ? (argv[index + 1] as string | undefined) : undefined;
};
const fresh = argv.includes("--fresh");
const rounds = Math.max(1, Number(at("--rounds") ?? "1"));

const workspaceDir =
	at("--workspace") ?? join(tmpdir(), "workbench-e2e-tenant");
const entry = resolve(import.meta.dir, "..", "..", "src", "index.ts");
const fakeAgent = resolve(import.meta.dir, "fake-agent.ts");

if (fresh) {
	await rm(workspaceDir, { recursive: true, force: true });
}
await mkdir(join(workspaceDir, ".workbench"), { recursive: true });

const ws: E2EWorkspace = { projectDir: workspaceDir, entry, fakeAgent };
console.log(`[e2e-tenant] workspace: ${workspaceDir}`);
console.log(`[e2e-tenant] rounds: ${rounds}`);

const runsDir = join(workspaceDir, "runs");
await mkdir(runsDir, { recursive: true });
const historyPath = join(runsDir, "history.jsonl");

let failed = 0;
for (let round = 1; round <= rounds; round += 1) {
	process.env.E2E_ROUND_INDEX = String(round);
	console.log(`\n===== round ${round}/${rounds} =====`);
	let report: E2EReport;
	try {
		report = await runE2E(ws, { keepWorkspace: true });
	} catch (error) {
		// 失败时租户目录保留（现场要留着诊断），报告记失败。
		report = {
			projectDir: workspaceDir,
			steps: [{ step: "run", ok: false, detail: { error: String(error) } }],
			stats: null,
			ledgerT0: null,
			sampleWindow: null,
			ok: false,
		};
	}

	const reportPath = join(
		runsDir,
		`report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
	);
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	await writeFile(
		historyPath,
		`${JSON.stringify({
			at: new Date().toISOString(),
			round,
			ok: report.ok,
			stats: report.stats,
			sampleWindow: report.sampleWindow,
		})}\n`,
		{ flag: "a" },
	);

	for (const step of report.steps) {
		console.log(`${step.ok ? "✓" : "✗"} ${step.step}`);
		if (!step.ok)
			console.log(`   ${JSON.stringify(step.detail).slice(0, 400)}`);
	}
	console.log(`[round ${round}] report: ${reportPath}`);
	if (!report.ok) failed += 1;
}

// 批次结束：租户黑板的 fit 账本（窗口 + 护城河四数字 + 闸门状态）
const ledgerProc = Bun.spawnSync(
	[process.execPath, resolve(import.meta.dir, "..", "fit-ledger.ts"), "--json"],
	{ cwd: workspaceDir },
);
if (ledgerProc.exitCode === 0) {
	const ledger = JSON.parse(
		new TextDecoder()
			.decode(ledgerProc.stdout)
			.slice(new TextDecoder().decode(ledgerProc.stdout).indexOf("{")),
	) as {
		sampleWindow?: SampleWindow;
		moat?: Array<{
			key: string;
			name: string;
			value: unknown;
			present: boolean;
		}>;
		gate?: { open: boolean; missing: string[] };
		t0?: { started: boolean; threads: number; writers: number };
	};
	console.log("\n===== 租户账本汇总 =====");
	console.log(`t0: ${JSON.stringify(ledger.t0)}`);
	console.log(`样本窗口: ${JSON.stringify(ledger.sampleWindow)}`);
	for (const m of ledger.moat ?? []) {
		console.log(
			`护城河 ${m.key} ${m.name}: ${JSON.stringify(m.value)} ${m.present ? "✓" : "✗"}`,
		);
	}
	console.log(
		`benchmark 闸门: ${ledger.gate?.open ? "开" : `关（缺 ${ledger.gate?.missing.join("、")}）`}`,
	);
	const md = Bun.spawnSync(
		[process.execPath, resolve(import.meta.dir, "..", "fit-ledger.ts")],
		{ cwd: workspaceDir },
	);
	if (md.exitCode === 0) {
		await writeFile(
			join(runsDir, "fit-ledger.md"),
			new TextDecoder().decode(md.stdout),
			"utf8",
		);
		console.log(`[e2e-tenant] ledger: ${join(runsDir, "fit-ledger.md")}`);
	}
} else {
	console.log(
		`[e2e-tenant] ledger 汇总失败：${new TextDecoder().decode(ledgerProc.stderr).slice(0, 200)}`,
	);
}

const priorHistory = await readFile(historyPath, "utf8").catch(() => "");
const totalLines = priorHistory.trim().split("\n").filter(Boolean).length;
console.log(`[e2e-tenant] 累计跑次：${totalLines}（本轮批次失败 ${failed}）`);
if (failed > 0) process.exit(1);

interface SampleWindow {
	satisfied: boolean;
	missing: string[];
	restores: number;
	noticeOutcomes: number;
	sealDecisions: number;
}
