/**
 * TF-0194 · 观察窗关窗对账
 *
 * 关窗时把开窗基线（t1-baseline.json）与当前 shown 行状态（shown-state.json）对账,
 * 再用真实 `workbench --json stats` 的 lifecycle.restores / resumeActions 校核恢复配额
 * 是否达标。数据来源全是本仓库现场:基线由开窗快照、shown-state 由观察窗逐行记录、
 * stats 由 CLI 现算——脚本自己不造任何数,只做减法与阈值判定。
 *
 * 用法:
 *   bun run packages/workbench/scripts/e2e/window-report.ts   # JSON 打到 stdout
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 开窗时观测到的 restores（固定基线,与 t1-baseline.json 的 lifecycle.restores 一致）。 */
const BASELINE_RESTORES = 140;
/** 观察窗要求窗口内新增的 restores 配额。 */
const QUOTA_RESTORES = 30;
/**
 * 开窗提交（74b6049）里 shown-state.json 已有 1 条记录——那是开窗前的手势,
 * 不属于本窗增量。复算：
 *   git show 74b6049:.agent-contexts/tf0194-window/shown-state.json
 * t1-baseline.json 是 stats 快照对象而非数组,不能拿来当 shown 基线数行。
 */
const BASELINE_SHOWN_ROWS = 1;

const HERE = dirname(fileURLToPath(import.meta.url));
// scripts/e2e → workbench → packages → 仓库根
const REPO_ROOT = resolve(HERE, "../../../..");
const WINDOW_DIR = join(REPO_ROOT, ".agent-contexts", "tf0194-window");

/** 只数行:文件是字符串数组时取长度,非数组（如 stats 对象）记 0,不抛。 */
function countRows(path: string): number {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	return Array.isArray(parsed) ? parsed.length : 0;
}

interface StatsLifecycle {
	restores?: number;
	resumeActions?: number;
}

/** 跑真实 CLI 拿 stats.lifecycle;失败即抛（对账不该在数据缺失时假装成功）。 */
function runStats(): Promise<StatsLifecycle> {
	return new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(
			process.execPath,
			["packages/workbench/src/index.ts", "--json", "stats"],
			{ cwd: REPO_ROOT },
		);
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => {
			out += chunk;
		});
		child.stderr.on("data", (chunk) => {
			err += chunk;
		});
		child.on("error", rejectPromise);
		child.on("close", (code) => {
			if (code !== 0) {
				rejectPromise(new Error(`stats 退出码 ${code}: ${err.slice(0, 300)}`));
				return;
			}
			try {
				const stats = JSON.parse(out) as { lifecycle?: StatsLifecycle };
				resolvePromise(stats.lifecycle ?? {});
			} catch (error) {
				rejectPromise(new Error(`stats JSON 解析失败: ${String(error)}`));
			}
		});
	});
}

async function reconcile(): Promise<Record<string, unknown>> {
	const shownRows = countRows(join(WINDOW_DIR, "shown-state.json"));
	const lifecycle = await runStats();
	const restores = lifecycle.restores ?? 0;
	const resumeActions = lifecycle.resumeActions ?? 0;
	const restoreDelta = restores - BASELINE_RESTORES;
	return {
		baselineRestores: BASELINE_RESTORES,
		quotaRestores: QUOTA_RESTORES,
		restores,
		restoreDelta,
		resumeActions,
		quotaMet: restoreDelta >= QUOTA_RESTORES,
		shownRows,
		shownGrowth: shownRows - BASELINE_SHOWN_ROWS,
	};
}

if (import.meta.main) {
	reconcile()
		.then((report) => {
			process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		})
		.catch((error) => {
			process.stderr.write(`${String(error)}\n`);
			process.exit(1);
		});
}
