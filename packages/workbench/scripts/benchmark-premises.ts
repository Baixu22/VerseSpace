/** Reproducible detector contract benchmark; no LLM, user-effect or speedup claims. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openBlackboard } from "../src/blackboard";
import { hashPathClaim } from "../src/blackboard/footprint";
import { type ReadSpan, writerSpoolDir } from "../src/blackboard/sessions";
import { initWorkbench } from "../src/commands/init";
import { reconcilePremises } from "../src/runtime/premises";

interface Scenario {
	name: string;
	path: string;
	before: string;
	after: string | null;
	notify: boolean;
	span?: ReadSpan;
	subject?: boolean;
	contentRead?: boolean;
	withoutSnapshot?: boolean;
	repeat?: boolean;
}

const body = "export function compute() { return 1; }\n";
const lines = "one\ntwo\nthree\nfour\n";
const scenarios: Scenario[] = [
	{
		name: "超过哈希上限的文件变大",
		path: "large.txt",
		before: "a".repeat(2_000_001),
		after: "b".repeat(2_000_002),
		notify: true,
	},
	{
		name: "超过哈希上限的文件未变",
		path: "large.txt",
		before: "a".repeat(2_000_001),
		after: "a".repeat(2_000_001),
		notify: false,
	},
	{
		name: "超过哈希上限的同尺寸改写（大小比较边界）",
		path: "large.txt",
		before: "a".repeat(2_000_001),
		after: "b".repeat(2_000_001),
		notify: false,
	},
	{
		name: "工作对象正文变化",
		path: "subject.ts",
		before: body,
		after: body.replace("1", "2"),
		subject: true,
		notify: true,
	},
	{
		name: "未标注内容读取的依赖正文变化（启发式边界）",
		path: "dependency.ts",
		before: body,
		after: body.replace("1", "2"),
		notify: false,
	},
	{
		name: "Read 全文复核后函数体变化（真实模型发现的漏报）",
		path: "reviewed.ts",
		before: body,
		after: body.replace("1", "2"),
		contentRead: true,
		notify: true,
	},
	{
		name: "依赖导出接口变化",
		path: "api.ts",
		before: body,
		after: body.replace("compute()", "compute(input: number)"),
		notify: true,
	},
	{
		name: "已读范围外的修改",
		path: "notes.txt",
		before: lines,
		after: lines.replace("four", "changed"),
		span: { start: 1, end: 3 },
		notify: false,
	},
	{
		name: "已读末尾之后插入",
		path: "notes.txt",
		before: lines,
		after: lines.replace("four", "inserted\nfour"),
		span: { start: 1, end: 3 },
		notify: false,
	},
	{
		name: "已读范围内部插入",
		path: "notes.txt",
		before: lines,
		after: lines.replace("two", "inserted\ntwo"),
		span: { start: 1, end: 3 },
		notify: true,
	},
	{
		name: "删除已读取的文件",
		path: "deleted.ts",
		before: body,
		after: null,
		notify: true,
	},
	{
		name: "耐久依赖变化",
		path: "node_modules/vendor/index.js",
		before: body,
		after: body.replace("1", "2"),
		notify: false,
	},
	{
		name: "读时快照缺失时保守提示",
		path: "unspooled.ts",
		before: body,
		after: body.replace("1", "2"),
		withoutSnapshot: true,
		notify: true,
	},
	{
		name: "同一失效前提重复检测",
		path: "repeat.txt",
		before: "old",
		after: "new",
		repeat: true,
		notify: false,
	},
];

interface Result {
	name: string;
	expected: string[];
	observed: string[];
	passed: boolean;
	elapsedMs: number;
}

async function runScenario(scenario: Scenario): Promise<Result> {
	const scratch = await mkdtemp(join(tmpdir(), "workbench-premise-bench-"));
	const target = resolve(scratch);
	if (
		dirname(target) !== resolve(tmpdir()) ||
		!basename(target).startsWith("workbench-premise-bench-")
	)
		throw new Error("拒绝使用非基准临时目录");
	try {
		await initWorkbench(scratch);
		const bb = openBlackboard(join(scratch, ".workbench"));
		const file = join(scratch, scenario.path);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, scenario.before);
		await bb.sessions.register("reader", "agent");
		const claim = await hashPathClaim(
			scratch,
			scenario.path,
			scenario.withoutSnapshot ? undefined : writerSpoolDir(bb.paths, "reader"),
			scenario.span,
		);
		await bb.sessions.recordActivity("reader", {
			activity: "baseline",
			agent: "reader",
			used: [claim],
			generated: scenario.subject ? [claim] : [],
			...(scenario.contentRead ? { facets: { tool: "Read" } } : {}),
		});
		if (scenario.after === null) await rm(file);
		else await writeFile(file, scenario.after);
		if (scenario.repeat && (await reconcilePremises(bb)).length !== 1)
			throw new Error("重复检测场景未产生首条通知");
		const started = performance.now();
		const notices = await reconcilePremises(bb);
		const elapsedMs = Number((performance.now() - started).toFixed(2));
		const observed = [
			...new Set(
				notices.flatMap((notice) => notice.stale.map((item) => item.path)),
			),
		].sort();
		const expected = scenario.notify ? [scenario.path] : [];
		return {
			name: scenario.name,
			expected,
			observed,
			passed: JSON.stringify(expected) === JSON.stringify(observed),
			elapsedMs,
		};
	} finally {
		await rm(target, { recursive: true, force: true, maxRetries: 3 });
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: { json: { type: "boolean" }, out: { type: "string" } },
	});
	const results: Result[] = [];
	for (const scenario of scenarios) results.push(await runScenario(scenario));
	const report = {
		generatedAt: new Date().toISOString(),
		platform: process.platform,
		bun: Bun.version,
		scope:
			"合成工作负载上的检测层契约；不代表真实用户精度、LLM 修补效果或总体加速。",
		passed: results.filter((result) => result.passed).length,
		total: results.length,
		results,
	};
	const markdown = [
		"# 前提检测基准（工程草案）",
		"",
		report.scope,
		"",
		`生成时间：${report.generatedAt}；环境：${report.platform} / Bun ${report.bun}。`,
		"",
		"复跑：`cd packages/workbench && bun scripts/benchmark-premises.ts`（可加 `--json` 或 `--out <文件>`）。",
		"",
		"耗时仅覆盖单次检测，包含本机文件系统与 git diff 成本；不是用户恢复耗时。",
		"",
		"| 场景 | 期望通知 | 实测通知 | 检测耗时 ms | 契约 |",
		"| --- | --- | --- | --- | --- |",
		...results.map(
			(result) =>
				`| ${result.name} | ${result.expected.join("、") || "无"} | ${result.observed.join("、") || "无"} | ${result.elapsedMs} | ${result.passed ? "通过" : "失败"} |`,
		),
		"",
		`通过 ${report.passed}/${report.total}。任一场景不符合预期时，命令退出码为 1。`,
		"",
	].join("\n");
	const output = values.json
		? `${JSON.stringify(report, null, 2)}\n`
		: markdown;
	if (values.out) await writeFile(values.out, output);
	else process.stdout.write(output);
	process.exitCode = report.passed === report.total ? 0 : 1;
}

if (import.meta.main) await main();
