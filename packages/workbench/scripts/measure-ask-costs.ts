/**
 * TF-0091 实测脚本：测量提议决策里的 B / C 机械成本，并计算提议区间。
 *
 * 模型（TF-0091 / TF-0106）：
 *   p = 用户想要某提议的先验概率
 *   K = 问一句的成本（打断 + 重新聚焦）
 *   B = 事后补结构的中位耗时（若用户确实想要，但没人问）
 *   C = 拆掉不想要的工作区的中位耗时（若做了用户不想要的）
 *   决策规则：p<K/B 沉默；K/B≤p≤1−K/C 提议；p>1−K/C 直接做
 *   提议区间存在 ⇔ K(1/B + 1/C) ≤ 1
 *
 * 本脚本实测两种路径的机械成本（本机真实 IO/文件系统）：
 *   B_mech  = 一次『晋升』（把对话变成 goal，写一个 YAML）的中位耗时
 *   C_mech  = 一次『拆除』：
 *     - worktree 路径（git worktree remove，重）
 *     - goal 路径（删一个 YAML，轻——设计可控的 C）
 *
 * 运行：bun run scripts/measure-ask-costs.ts
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBlackboard } from "../src/blackboard";
import { initWorkbench } from "../src/commands/init";

function git(root: string, args: string[]): void {
	execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

function median(times: number[]): number {
	const sorted = [...times].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[mid]!
		: (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** C（重路径）：git worktree 拆除的中位耗时（毫秒）。 */
function measureWorktreeRemoval(runs: number): number[] {
	const root = mkdtempSync(join(tmpdir(), "ask-cost-wt-"));
	try {
		git(root, ["init", "-q", "-b", "main"]);
		writeFileSync(join(root, "README.md"), "hi\n");
		git(root, ["add", "."]);
		git(root, ["commit", "-q", "-m", "init"]);
		const times: number[] = [];
		for (let i = 0; i < runs; i += 1) {
			const wt = join(root, `wt${i}`);
			git(root, ["worktree", "add", wt, "-b", `branch-${i}`]);
			const t0 = performance.now();
			git(root, ["worktree", "remove", "--force", wt]);
			times.push(performance.now() - t0);
		}
		return times;
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	}
}

/** B_mech + C_goal（轻路径）：goal 创建与删除的中位耗时（毫秒）。 */
async function measureGoalOps(
	runs: number,
): Promise<{ add: number[]; remove: number[] }> {
	const root = mkdtempSync(join(tmpdir(), "ask-cost-goal-"));
	try {
		await initWorkbench(root);
		const bb = openBlackboard(join(root, ".workbench"));
		mkdirSync(bb.paths.goals, { recursive: true });
		const adds: number[] = [];
		const removes: number[] = [];
		for (let i = 0; i < runs; i += 1) {
			const t0 = performance.now();
			const goal = await bb.goals.add({ title: `目标 ${i}` });
			adds.push(performance.now() - t0);

			const t1 = performance.now();
			rmSync(join(bb.paths.goals, `${goal.id}.yaml`), { force: true });
			removes.push(performance.now() - t1);
		}
		return { add: adds, remove: removes };
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	}
}

function fmt(ms: number): string {
	return ms < 1_000 ? `${ms.toFixed(0)}ms` : `${(ms / 1_000).toFixed(2)}s`;
}

async function main(): Promise<void> {
	const wtTimes = measureWorktreeRemoval(5);
	const goal = await measureGoalOps(15);
	const cWorktreeMs = median(wtTimes);
	const cGoalMs = median(goal.remove);
	const bGoalMs = median(goal.add);

	// 认知成本修正（下限为 0，机械成本即下限）
	const B_lo = bGoalMs; // 机械下限
	const C_lo = cGoalMs; // 轻路径机械下限

	console.log("== 实测（本机真实 IO，中位数）==");
	console.log(
		`C_worktree（git worktree 拆除）: ${fmt(cWorktreeMs)}  样本=${wtTimes.map(fmt).join(", ")}`,
	);
	console.log(
		`C_goal（删一个 goal YAML）    : ${fmt(cGoalMs)}  样本=${goal.remove.map(fmt).join(", ")}`,
	);
	console.log(
		`B_goal（创建 goal = 晋升）    : ${fmt(bGoalMs)}  样本=${goal.add.map(fmt).join(", ")}`,
	);

	// 把认知成本加进去的估计：机械 × 认知倍数（5x 为保守上界，含思考/确认）
	const est = (mechMs: number, factor: number) => mechMs * factor;
	const rows: Array<{
		kSec: number;
		Bms: number;
		Cms: number;
		lhs: number;
		label: string;
		verdict: string;
	}> = [];
	for (const kSec of [2, 5, 10, 30]) {
		const Kms = kSec * 1_000;
		for (const [Bms, Cms, label] of [
			[B_lo, C_lo, "机械下限"],
			[est(B_lo, 3), est(C_lo, 3), "认知×3"],
			[est(B_lo, 5), est(C_lo, 5), "认知×5"],
		] as const) {
			const lhs = Kms * (1 / Bms + 1 / Cms);
			rows.push({
				kSec,
				Bms,
				Cms,
				lhs,
				label,
				verdict:
					lhs <= 1
						? `区间存在：K/B=${(Kms / Bms).toFixed(2)} ≤ 1−K/C=${(1 - Kms / Cms).toFixed(2)}，p*=${(Cms / (Bms + Cms)).toFixed(2)}`
						: `区间为空（K(1/B+1/C)=${lhs.toFixed(2)}>1）→ 永远沉默或永远直接做`,
			});
		}
	}

	console.log("\n== 提议区间敏感性 ==");
	console.log("K(1/B+1/C) ≤ 1 才存在提议区间；C 是唯一可设计控制的项。");
	for (const r of rows) {
		console.log(
			`  K=${r.kSec}s  ${r.label.padEnd(5)} B=${fmt(r.Bms)}  C=${fmt(r.Cms)}  → ${r.verdict}`,
		);
	}

	// 关键对比：轻路径 C（goal）vs 重路径 C（worktree）
	console.log("\n== 设计杠杆：C 的下限 ===");
	console.log(
		`  拆 worktree 比删 goal YAML 贵 ${(cWorktreeMs / Math.max(1, cGoalMs)).toFixed(1)}×（C 靠设计可降一个量级）`,
	);
}

await main();
