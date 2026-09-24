/**
 * 全量测试总账：一条命令拿到**可复现**的读数（TF-0158 验收三）。
 *
 * 为什么不是一个 `bun test`：这个包里有文件在 Bun 1.4.2 上会挂起（跑完某个用例
 * 之后连定时器都不再触发，`live-provider.test.ts` 是现场）。整包跑一旦踩到它就
 * 永远收不了尾，读数就变成「看谁记得排除哪个文件」。
 *
 * 而且实测还有一个坑：**把 93 个文件路径一次交给一个 `bun test` 进程会卡住，
 * 同样的文件按目录交进去却 37.8s 跑完**——所以本脚本改成**逐个文件单独起进程**，
 * 每个文件带自己的硬超时。这样既拿到总账，又能把「哪个文件计量不了」单独点出来。
 *
 * 另外：Bun 把汇总行（`N pass` / `Ran N tests across N files`）写在 **stderr**，
 * 不是 stdout——只读 stdout 会把跑完的批次误判成「挂起」。
 *
 * 退出码：有用例失败 → 1；有文件计量不了（崩溃/挂起）→ 2；全部计量且绿 → 0。
 * 绝不用「没拿到总账」冒充绿。
 *
 * 用法：
 *   bun scripts/suite-total.ts
 *   bun scripts/suite-total.ts --json <路径>        # 默认写系统临时目录
 *   bun scripts/suite-total.ts --only src/interactions
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

/** 单个文件的硬超时：正常的几百毫秒，慢的（e2e.test.ts 47s）也够，挂起的会被砍。 */
const PER_FILE_BUDGET_MS = 120_000;

const argv = Bun.argv.slice(2);
const jsonIndex = argv.indexOf("--json");
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const jsonPath =
	jsonIndex >= 0 && argv[jsonIndex + 1]
		? argv[jsonIndex + 1]!
		: join(tmpdir(), "workbench-suite-total.json");

/** 包根目录：glob 与 bun test 都以它为基准（相对路径要带 scripts/ 前缀）。 */
const root = join(import.meta.dir, "..");

async function collect(): Promise<string[]> {
	const files: string[] = [];
	for await (const entry of new Bun.Glob("**/*.test.ts").scan({
		cwd: root,
		dot: false,
	})) {
		if (entry.includes("node_modules")) continue;
		const posix = entry.split("\\").join("/");
		if (only && !posix.includes(only)) continue;
		files.push(posix);
	}
	return files.sort();
}

/** 汇总行在 stderr，所以两份输出都要看。没有汇总行就不算计量成功。 */
function readTotal(text: string) {
	const pass = text.match(/^\s*(\d+)\s+pass\s*$/m)?.[1];
	const fail = text.match(/^\s*(\d+)\s+fail\s*$/m)?.[1];
	if (!pass || !fail) return null;
	// 单文件跑时 Bun 写的是 "across 1 file"（单数），整包跑才是 "files"
	const ran = text.match(/Ran (\d+) tests across (\d+) files?/);
	return {
		pass: Number(pass),
		fail: Number(fail),
		tests: ran ? Number(ran[1]) : null,
		snapshot: Number(text.match(/^\s*(\d+)\s+snapshot\s*$/m)?.[1] ?? 0),
	};
}

type Row = {
	file: string;
	elapsedMs: number;
	exitCode: number;
	state: "ok" | "fail" | "crash" | "hang";
	pass: number;
	fail: number;
	tests: number;
	snapshot: number;
	note: string;
};

async function runFile(file: string): Promise<Row> {
	const started = Date.now();
	const proc = Bun.spawn(
		[process.execPath, "test", file, "--timeout", "60000"],
		{ cwd: root, stdout: "pipe", stderr: "pipe" },
	);
	let killed = false;
	const killer = setTimeout(() => {
		killed = true;
		proc.kill();
	}, PER_FILE_BUDGET_MS);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const exitCode = await proc.exited;
	clearTimeout(killer);
	const combined = `${stdout}\n${stderr}`;
	const total = readTotal(combined);
	const crashed = /panic\(|Segmentation fault/.test(combined) || exitCode === 3;
	const state: Row["state"] = total
		? total.fail > 0
			? "fail"
			: "ok"
		: crashed
			? "crash"
			: "hang";
	return {
		file,
		elapsedMs: Date.now() - started,
		exitCode,
		state,
		pass: total?.pass ?? 0,
		fail: total?.fail ?? 0,
		tests: total?.tests ?? 0,
		snapshot: total?.snapshot ?? 0,
		note: total
			? ""
			: crashed
				? "Bun 运行时崩溃（环境问题，不是用例失败）"
				: killed
					? `${PER_FILE_BUDGET_MS / 1000}s 未收尾：文件内挂起（TF-0158）`
					: "进程未产出汇总行",
	};
}

const files = await collect();
if (files.length === 0) {
	console.error("[suite-total] 没找到用例文件");
	process.exit(2);
}
console.log(`[suite-total] 逐个文件跑，共 ${files.length} 个`);

const rows: Row[] = [];
for (const file of files) {
	const row = await runFile(file);
	rows.push(row);
	// 正常文件不刷屏，只报异常与慢的
	if (row.state !== "ok" || row.elapsedMs > 3_000)
		console.log(
			`[suite-total] ${file} → ${row.state}${row.pass ? ` ${row.pass} pass` : ""}` +
				`${row.fail ? ` ${row.fail} fail` : ""} · ${(row.elapsedMs / 1000).toFixed(1)}s` +
				`${row.note ? ` · ${row.note}` : ""}`,
		);
}

const measured = rows.filter(
	(row) => row.state === "ok" || row.state === "fail",
);
const unmeasured = rows.filter(
	(row) => row.state === "crash" || row.state === "hang",
);
const sums = measured.reduce(
	(acc, row) => ({
		pass: acc.pass + row.pass,
		fail: acc.fail + row.fail,
		tests: acc.tests + row.tests,
		snapshot: acc.snapshot + row.snapshot,
	}),
	{ pass: 0, fail: 0, tests: 0, snapshot: 0 },
);

console.log(
	`[suite-total] ${sums.pass} pass · ${sums.fail} fail · ${sums.snapshot} snapshot · ` +
		`${measured.length}/${rows.length} 文件可计量 / ${sums.tests} 用例`,
);
if (unmeasured.length > 0)
	console.log(
		`[suite-total] 计量不了 ${unmeasured.length} 个：${unmeasured
			.map((row) => `${row.file}（${row.note}）`)
			.join("；")}`,
	);

const artifact = {
	at: new Date().toISOString(),
	mode: only ? `--only ${only}` : "全量",
	sums,
	files: rows.length,
	measured: measured.length,
	unmeasured,
	rows,
};
await Bun.write(jsonPath, `${JSON.stringify(artifact, null, 1)}\n`);
console.log(`[suite-total] 工件：${jsonPath}`);

process.exit(sums.fail > 0 ? 1 : unmeasured.length > 0 ? 2 : 0);
