/**
 * 租户累积跑：把 E2E 场景对一个持久工作区反复执行，让真实进程样本
 * 跨跑次累积——样本窗口（restore/notice/seal）由此凑齐，这是
 * 2026-09-06 用户决策的样本源（agent 驱动的真实集成跑，替代人工日用）。
 *
 * 用法：
 *   bun scripts/e2e/run.ts               # 用默认持久工作区跑一轮
 *   bun scripts/e2e/run.ts --fresh       # 清空工作区后重新开始
 *   bun scripts/e2e/run.ts --workspace <dir>
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

let report: E2EReport;
try {
	report = await runE2E(ws, { keepWorkspace: true });
} catch (error) {
	// runE2E 失败时租户目录保留（现场要留着诊断），报告记失败。
	report = {
		projectDir: workspaceDir,
		steps: [{ step: "run", ok: false, detail: { error: String(error) } }],
		stats: null,
		ledgerT0: null,
		sampleWindow: null,
		ok: false,
	};
}

const runsDir = join(workspaceDir, "runs");
await mkdir(runsDir, { recursive: true });
const reportPath = join(
	runsDir,
	`report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const historyPath = join(runsDir, "history.jsonl");
await writeFile(
	historyPath,
	`${JSON.stringify({
		at: new Date().toISOString(),
		ok: report.ok,
		stats: report.stats,
		sampleWindow: report.sampleWindow,
	})}\n`,
	{ flag: "a" },
);

for (const step of report.steps) {
	console.log(`${step.ok ? "✓" : "✗"} ${step.step}`);
	if (!step.ok) console.log(`   ${JSON.stringify(step.detail).slice(0, 400)}`);
}
console.log(`[e2e-tenant] report: ${reportPath}`);
console.log(
	`[e2e-tenant] sampleWindow: ${JSON.stringify(report.sampleWindow)}`,
);

// 把租户黑板的最新 fit 账本一并落进租户目录，方便跨跑次查看窗口进度。
try {
	const ledgerProc = Bun.spawnSync(
		[process.execPath, resolve(import.meta.dir, "..", "fit-ledger.ts")],
		{ cwd: workspaceDir },
	);
	if (ledgerProc.exitCode === 0) {
		await writeFile(
			join(runsDir, "fit-ledger.md"),
			new TextDecoder().decode(ledgerProc.stdout),
			"utf8",
		);
		console.log(`[e2e-tenant] ledger: ${join(runsDir, "fit-ledger.md")}`);
	} else {
		console.log(
			`[e2e-tenant] ledger 生成失败：${new TextDecoder().decode(ledgerProc.stderr).slice(0, 200)}`,
		);
	}
} catch (error) {
	console.log(`[e2e-tenant] ledger 生成异常：${String(error)}`);
}

const priorHistory = await readFile(historyPath, "utf8").catch(() => "");
const okRuns = priorHistory.trim().split("\n").filter(Boolean).length;
console.log(`[e2e-tenant] 累计成功跑次：${okRuns}`);
if (!report.ok) process.exit(1);
