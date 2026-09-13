/**
 * TF-0091 · 实测 B 与 C
 *
 * 模型出自 docs/positioning-v6.md §L2 与 ADR-0008 §6（Horvitz 期望效用几何）：
 *
 *   p <  K/B          → 沉默
 *   K/B ≤ p ≤ 1−K/C   → 提议
 *   p >  1−K/C        → 直接做
 *
 * 当 K(1/B + 1/C) > 1 时提议区间为空——不存在任何 p 使询问最优。
 *
 * 本脚本实测两个分母：
 *   B = 事后补结构的成本   —— 一段无名会话事后被追认为正经任务时，用户要付的代价
 *                            （goal add → sync → ws create → dispatch，含建 worktree）
 *   C = 拆掉不想要的工作区的成本 —— 事后发现这个工位不想要时，用户要付的代价
 *                            （worktree remove → branch -d → 清工位状态 → cancel 目标）
 *
 * 单位统一为「秒」。K 不在本脚本内实测（见 K-NOTES），脚本只产 B/C 的原始样本与中位数。
 *
 * ⚠ 环境注意（2026-08-31 实测）：本机 git 2.55.0.windows.3 无法创建**含 `/` 的分支名**——
 *   `git branch a/b` 与 `git update-ref refs/heads/a/b HEAD` 都返回 0 但 ref 根本没建出来，
 *   预建目录、关 reflog、关 sandbox 均无效。workbench 的默认分支名是 `ws/{id}`，所以
 *   `dispatch` 在本机必然以 `fatal: invalid reference: ws/x` 失败。
 *   本脚本因此默认用扁平分支名 `bc{i}` 绕开；这个坑本身已作为 TF-0091 的证据记录。
 *
 * 用法：
 *   bun run scripts/measure-bc.ts [--trials 7] [--json out.jsonl] [--nested]
 *   --nested  用 `bc{i}/w` 这种含斜杠的分支名（在本机会失败，仅用于复现该环境 bug）
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO_ROOT, "packages", "workbench", "src", "index.ts");

interface Sample {
	trial: number;
	phase: "B" | "C";
	totalMs: number;
	steps: { step: string; ms: number }[];
}

interface RunOptions {
	trials: number;
	outPath: string | null;
	nested: boolean;
}

function parseArgs(argv: string[]): RunOptions {
	const opts: RunOptions = { trials: 7, outPath: null, nested: false };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--trials") opts.trials = Number(argv[++i]);
		else if (argv[i] === "--json") opts.outPath = argv[++i] ?? null;
		else if (argv[i] === "--nested") opts.nested = true;
	}
	return opts;
}

const now = () => performance.now();

interface SpawnResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	ms: number;
}

async function run(args: string[], cwd: string): Promise<SpawnResult> {
	const start = now();
	const proc = Bun.spawn(["bun", "run", CLI, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { ok: code === 0, stdout, stderr, ms: now() - start };
}

/**
 * 解析 `--json` 输出。CLI 的 emitJson 是 pretty-print 的多行 JSON，
 * 所以不能按行解析：先整段试，再退回到「从第一个 { 或 [ 起截到末尾」。
 */
function parseJson<T>(text: string): T | null {
	const trimmed = text.trim();
	try {
		return JSON.parse(trimmed) as T;
	} catch {
		/* 落到下面 */
	}
	const start = trimmed.search(/[[{]/);
	if (start === -1) return null;
	try {
		return JSON.parse(trimmed.slice(start)) as T;
	} catch {
		return null;
	}
}

async function git(args: string[], cwd: string): Promise<SpawnResult> {
	const start = now();
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { ok: code === 0, stdout, stderr, ms: now() - start };
}

async function sh(args: string[], cwd: string): Promise<SpawnResult> {
	const start = now();
	const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	return { ok: code === 0, stdout, stderr, ms: now() - start };
}

function median(xs: number[]): number {
	if (xs.length === 0) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	const lo = s[mid - 1] ?? Number.NaN;
	const hi = s[mid] ?? Number.NaN;
	return s.length % 2 === 0 ? (lo + hi) / 2 : hi;
}

function pct(xs: number[], p: number): number {
	if (xs.length === 0) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	const idx = Math.min(
		s.length - 1,
		Math.max(0, Math.ceil((p / 100) * s.length) - 1),
	);
	return s[idx] ?? Number.NaN;
}

async function main(): Promise<void> {
	const opts = parseArgs(Bun.argv.slice(2));
	const scratch = join(tmpdir(), `wb-bc-${Date.now()}`);
	await mkdir(scratch, { recursive: true });

	console.log(`scratch repo: ${scratch}`);
	console.log(`trials: ${opts.trials}\n`);

	await git(["init", "-q"], scratch);
	await git(["config", "user.email", "bc@measure.local"], scratch);
	await git(["config", "user.name", "BC Measure"], scratch);
	await writeFile(join(scratch, "README.md"), "# scratch\n");
	await git(["add", "."], scratch);
	await git(["commit", "-q", "-m", "initial"], scratch);

	const init = await run(["init"], scratch);
	if (!init.ok) {
		console.error("workbench init 失败：", init.stderr);
		process.exit(1);
	}

	const samples: Sample[] = [];

	for (let i = 0; i < opts.trials; i += 1) {
		const id = `bc${i}`;
		// 扁平分支名是本机能跑通的唯一形式，见文件头注记。
		const branch = opts.nested ? `bc${i}/w` : `bc${i}`;
		const stepsB: { step: string; ms: number }[] = [];
		const t0 = now();

		// --- B：事后补结构 -------------------------------------------------
		const add = await run(
			["goal", "add", `事后补结构 #${i}`, "--json"],
			scratch,
		);
		stepsB.push({ step: "goal add", ms: add.ms });
		const goal = parseJson<{ id: string }>(add.stdout);
		if (!goal?.id) {
			console.error(
				`trial ${i}: 拿不到 goal id —— ${add.stdout}\n${add.stderr}`,
			);
			break;
		}

		const sync = await run(["sync"], scratch);
		stepsB.push({ step: "sync", ms: sync.ms });

		const create = await run(
			[
				"ws",
				"create",
				`ws-${id}`,
				"--task",
				goal.id,
				"--branch",
				branch,
				"--json",
			],
			scratch,
		);
		stepsB.push({ step: "ws create", ms: create.ms });
		if (!create.ok) {
			console.error(`trial ${i}: ws create 失败 —— ${create.stderr}`);
			break;
		}

		const dispatch = await run(
			["dispatch", goal.id, `ws-${id}`, "--json"],
			scratch,
		);
		stepsB.push({ step: "dispatch (建 worktree)", ms: dispatch.ms });
		if (!dispatch.ok) {
			console.error(`trial ${i}: dispatch 失败 —— ${dispatch.stderr}`);
			break;
		}

		const totalB = now() - t0;
		samples.push({ trial: i, phase: "B", totalMs: totalB, steps: stepsB });

		// --- C：拆掉不想要的工作区 -----------------------------------------
		const stepsC: { step: string; ms: number }[] = [];
		const t1 = now();

		const wt = await git(
			["worktree", "remove", join(scratch, "worktrees", `ws-${id}`)],
			scratch,
		);
		stepsC.push({ step: "git worktree remove", ms: wt.ms });
		if (!wt.ok) stepsC.push({ step: `  ⚠ ${wt.stderr.trim()}`, ms: 0 });

		const br = await git(["branch", "-d", branch], scratch);
		stepsC.push({ step: "git branch -d", ms: br.ms });

		const del = await sh(
			[
				"rm",
				"-f",
				join(
					scratch,
					".workbench",
					"blackboard",
					"state",
					"workspots",
					`ws-${id}.yaml`,
				),
			],
			scratch,
		);
		stepsC.push({ step: "删工位状态文件", ms: del.ms });

		const cancel = await run(["goal", "cancel", goal.id], scratch);
		stepsC.push({ step: "goal cancel", ms: cancel.ms });

		const totalC = now() - t1;
		samples.push({ trial: i, phase: "C", totalMs: totalC, steps: stepsC });

		console.log(
			`trial ${i}:  B=${(totalB / 1000).toFixed(2)}s  C=${(totalC / 1000).toFixed(2)}s`,
		);
	}

	const b = samples.filter((s) => s.phase === "B").map((s) => s.totalMs / 1000);
	const c = samples.filter((s) => s.phase === "C").map((s) => s.totalMs / 1000);

	console.log(`\n${"=".repeat(56)}`);
	console.log("B（事后补结构，秒）");
	console.log(`  样本  ${b.map((x) => x.toFixed(2)).join(", ")}`);
	console.log(
		`  中位  ${median(b).toFixed(2)}   p25 ${pct(b, 25).toFixed(2)}   p75 ${pct(b, 75).toFixed(2)}`,
	);
	console.log("C（拆掉不想要的工作区，秒）");
	console.log(`  样本  ${c.map((x) => x.toFixed(2)).join(", ")}`);
	console.log(
		`  中位  ${median(c).toFixed(2)}   p25 ${pct(c, 25).toFixed(2)}   p75 ${pct(c, 75).toFixed(2)}`,
	);

	// 分步耗时（中位数），用来看成本到底堆在哪一步
	for (const phase of ["B", "C"] as const) {
		const rows = samples.filter((s) => s.phase === phase);
		if (rows.length === 0) continue;
		console.log(`\n${phase} 分步耗时（中位，毫秒）`);
		const names = rows[0]!.steps
			.map((s) => s.step)
			.filter((s) => !s.startsWith("  "));
		for (const name of names) {
			const vals = rows
				.map((r) => r.steps.find((s) => s.step === name)?.ms)
				.filter((v): v is number => v !== undefined);
			console.log(`  ${name.padEnd(24)} ${median(vals).toFixed(0)}`);
		}
	}

	if (opts.outPath) {
		const lines = samples.map((s) => JSON.stringify(s)).join("\n");
		await writeFile(opts.outPath, `${lines}\n`, "utf8");
		console.log(`\n原始样本 → ${opts.outPath}`);
	}

	console.log(`\n清理 ${scratch} ...`);
	await rm(scratch, { recursive: true, force: true });
	console.log("done.");
}

await main();
