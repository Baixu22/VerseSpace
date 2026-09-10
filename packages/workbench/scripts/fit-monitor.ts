/**
 * TF-0135 / TF-0136 / TF-0137 · fit 数据监控入口。
 *
 * 存在的理由是给「等真实使用」换一种做法：与其等人日用一个月再回头判断，
 * 不如让每一次真实模型采样都落成一条可比对的样本，由差分规则先说出「哪一项
 * 退了、哪一项在等谁」。这样工程侧的问题在当天就会暴露，而真正需要人的那两项
 * （L1 认可率、恢复卡人类耗时）会以「待办数量 + 一条命令」的形式出现，不再是
 * 一句含糊的阻塞。
 *
 * 用法：
 *   bun scripts/fit-monitor.ts                                   # 采样一次并对照上一份
 *   bun scripts/fit-monitor.ts --out ../../docs/fit-monitor.md   # 写报告
 *   bun scripts/fit-monitor.ts --json                            # 机读
 *   bun scripts/fit-monitor.ts --fail-on warn                    # CI 式闸门
 *   bun scripts/fit-monitor.ts --workspace <租户> --scope <仓库>  # 黑板与森林分处两地
 *
 * 只读：不写黑板、不改森林状态；样本追加到租户的 runs/monitor-series.jsonl。
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseEvidenceKind } from "./fit-ledger/verdicts";
import { evaluateAlerts } from "./fit-monitor/alerts";
import { renderMonitorReport } from "./fit-monitor/render";
import { buildSample } from "./fit-monitor/sample";
import {
	type Alert,
	type MonitorSample,
	SEVERITY_RANK,
	type Severity,
	worstSeverity,
} from "./fit-monitor/types";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

const argv = Bun.argv.slice(2);
const at = (flag: string): string | undefined => {
	const index = argv.indexOf(flag);
	return index >= 0 ? (argv[index + 1] as string | undefined) : undefined;
};

const workspace =
	at("--workspace") ?? join(tmpdir(), "workbench-e2e-live-tenant");
const scope = at("--scope") ?? REPO_ROOT;
const evidenceKind = parseEvidenceKind(at("--evidence-kind") ?? "live-model");
const snapshotDir = at("--snapshot-dir") ?? join(REPO_ROOT, "docs");
const seriesPath =
	at("--series") ?? join(workspace, "runs/monitor-series.jsonl");

const readSeries = async (): Promise<MonitorSample[]> => {
	const text = await readFile(seriesPath, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as MonitorSample)
		.filter(
			(sample) =>
				sample.workspace === workspace && sample.evidenceKind === evidenceKind,
		);
};

const changed = (before: MonitorSample, after: MonitorSample): boolean =>
	before.rounds.total !== after.rounds.total ||
	before.threads !== after.threads ||
	before.writers !== after.writers ||
	before.events !== after.events ||
	before.sampleWindow.restores !== after.sampleWindow.restores ||
	before.sampleWindow.noticeOutcomes !== after.sampleWindow.noticeOutcomes ||
	before.sampleWindow.sealDecisions !== after.sampleWindow.sealDecisions ||
	before.natural.reviewed !== after.natural.reviewed;

async function main(): Promise<void> {
	const series = await readSeries();
	const previous = series.at(-1) ?? null;
	const current = await buildSample({
		workspace,
		evidenceKind,
		scope,
		snapshotDir,
	});
	const alerts = evaluateAlerts(previous, current);

	let appended = false;
	if (
		!argv.includes("--no-append") &&
		(!previous || changed(previous, current))
	) {
		await mkdir(dirname(seriesPath), { recursive: true });
		await appendFile(seriesPath, `${JSON.stringify(current)}\n`);
		appended = true;
	}
	const samples = [...series, current];

	const report = renderMonitorReport({
		samples,
		alerts,
		current,
		title: `由 \`bun scripts/fit-monitor.ts\` 生成；样本序列 \`${seriesPath}\``,
	});
	const outPath = at("--out");
	if (outPath) {
		await mkdir(dirname(resolve(outPath)), { recursive: true });
		await writeFile(resolve(outPath), report, "utf8");
	}

	if (argv.includes("--json")) {
		console.log(
			JSON.stringify(
				{
					sample: current,
					alerts,
					appended,
					seriesLength: samples.length,
					worst: worstSeverity(alerts),
				},
				null,
				2,
			),
		);
	} else if (outPath) {
		console.log(`wrote ${resolve(outPath)}`);
	} else {
		console.log(report);
	}

	if (!argv.includes("--json")) {
		console.log(
			`[fit-monitor] 样本 ${samples.length} 条${appended ? "（已追加本次）" : "（本次与上一条无变化，未追加）"}；告警 ${alerts.length} 条`,
		);
		summarise(alerts);
	}

	const failOn = (at("--fail-on") ?? "high") as Severity | "none";
	if (failOn !== "none") {
		const worst = worstSeverity(alerts);
		if (worst && SEVERITY_RANK[worst] >= SEVERITY_RANK[failOn]) {
			process.exitCode = 1;
			if (!argv.includes("--json"))
				console.log(`[fit-monitor] 退出码 1：出现 ${failOn} 级告警`);
		}
	}
}

function summarise(alerts: Alert[]): void {
	for (const alert of alerts)
		console.log(
			`  [${alert.severity}] ${alert.id} · ${alert.title} — ${alert.evidence}`,
		);
}

await main();
