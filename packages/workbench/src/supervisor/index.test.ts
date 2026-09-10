import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	crashLoopTripped,
	isProcessAlive,
	reapOrphans,
	spawnSupervised,
	splitCommandLine,
} from "./index";

function makeDir(
	prefix: string,
): Promise<{ dir: string; cleanup(): Promise<void> }> {
	return (async () => {
		const dir = join(
			tmpdir(),
			`${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(dir, { recursive: true });
		return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
	})();
}

async function pollFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs = 8000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error("pollFor timed out");
}

describe("splitCommandLine", () => {
	test("splits on whitespace and keeps quoted segments intact", () => {
		expect(splitCommandLine("bun run tool.js --flag")).toEqual([
			"bun",
			"run",
			"tool.js",
			"--flag",
		]);
		expect(splitCommandLine('bun "my tool.js" -x')).toEqual([
			"bun",
			"my tool.js",
			"-x",
		]);
	});
});

describe("spawnSupervised", () => {
	test("spawns argv-style without a shell and streams lines", async () => {
		const { dir, cleanup } = await makeDir("workbench-supervisor");
		try {
			await writeFile(
				join(dir, "echo.js"),
				[
					'console.log("line-1");',
					'console.error("err-1");',
					'console.log("line-2");',
				].join("\n"),
				"utf8",
			);
			const lines: string[] = [];
			const proc = spawnSupervised(`bun ${join(dir, "echo.js")}`, {
				label: "echo",
				onLine: (line, kind) => lines.push(`${kind}:${line}`),
			});
			const outcome = await proc.wait();
			expect(outcome.exitCode).toBe(0);
			expect(lines).toContain("out:line-1");
			expect(lines).toContain("err:err-1");
			expect(lines).toContain("out:line-2");
		} finally {
			await cleanup();
		}
	});

	test("路径带空格的 .cmd 垫片也能跑通（cmd /s 的双引号规则）", async () => {
		if (process.platform !== "win32") {
			return; // POSIX 没有 .cmd 垫片这条路径
		}
		// 前缀里故意留一个空格：npm 全局垫片的常见位置（`C:\Users\John Doe\
		// AppData\Roaming\npm\x.cmd`）和本机沙箱运行时都在带空格的目录下。
		// 2026-09-11 之前这里是坏的：`cmd /c` 只给路径加引号，而 Node/bun 会把
		// 元素内部的引号转义成 `\"`，cmd 不认 `\"`，于是报「不是内部或外部命令」，
		// 对话整条链路表现为「agent 退出码 1」且零输出——而这一族问题在测试里
		// 一直看不见，因为临时目录从来不带空格。
		const { dir, cleanup } = await makeDir("workbench supervisor shim");
		try {
			await writeFile(
				join(dir, "shim.cmd"),
				["@echo off", "echo shim-ran", ""].join("\r\n"),
				"utf8",
			);
			const lines: string[] = [];
			const proc = spawnSupervised(`"${join(dir, "shim.cmd")}"`, {
				label: "space-shim",
				onLine: (line, kind) => lines.push(`${kind}:${line}`),
			});
			const outcome = await proc.wait();
			expect(outcome.error).toBeUndefined();
			expect(outcome.exitCode).toBe(0);
			// cmd.exe 的行以 CRLF 结尾，逐行比较前去掉尾部空白
			expect(lines.map((line) => line.trim())).toContain("out:shim-ran");
		} finally {
			await cleanup();
		}
	});

	test("kill() takes down the whole tree on Windows", async () => {
		if (process.platform !== "win32") {
			return; // POSIX group-kill is exercised by the same code path shape
		}
		const { dir, cleanup } = await makeDir("workbench-supervisor-tree");
		try {
			// the parent spawns a long-lived grandchild and records its pid;
			// killing the parent through the supervisor must reap the
			// grandchild too — the exact failure mode of `child.kill()` on a
			// cmd.exe shim
			await writeFile(
				join(dir, "sleeper.js"),
				"setInterval(() => {}, 1000);\n",
				"utf8",
			);
			await writeFile(
				join(dir, "parent.js"),
				[
					"const { execSync } = require('node:child_process');",
					"const grand = require('node:child_process').spawn(process.execPath, [process.argv[1].replace('parent.js', 'sleeper.js')], { detached: true, stdio: 'ignore' });",
					"grand.unref();",
					"require('node:fs').writeFileSync(process.argv[1] + '.pid', String(grand.pid));",
					"setInterval(() => {}, 1000);",
				].join("\n"),
				"utf8",
			);
			const proc = spawnSupervised(`bun ${join(dir, "parent.js")}`, {
				label: "tree",
			});
			await pollFor(async () => {
				try {
					await readFile(join(dir, "parent.js.pid"), "utf8");
					return true;
				} catch {
					return false;
				}
			});
			const grandPid = Number(
				await readFile(join(dir, "parent.js.pid"), "utf8"),
			);
			expect(Number.isFinite(grandPid)).toBe(true);
			expect(isProcessAlive(grandPid)).toBe(true);

			await proc.kill();
			await proc.wait();
			await pollFor(() => !isProcessAlive(grandPid));
			expect(isProcessAlive(proc.pid ?? -1)).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("pid registry records a running process and reapOrphans kills it", async () => {
		const { dir, cleanup } = await makeDir("workbench-supervisor-reap");
		try {
			const registryDir = join(dir, "proc");
			await writeFile(
				join(dir, "sleeper.js"),
				"setInterval(() => {}, 1000);\n",
				"utf8",
			);
			const proc = spawnSupervised(`bun ${join(dir, "sleeper.js")}`, {
				label: "sleeper",
				registryDir,
			});
			await pollFor(async () => {
				const { readdir } = await import("node:fs/promises");
				return (await readdir(registryDir).catch(() => [])).length > 0;
			});
			expect(proc.pid).toBeDefined();
			expect(isProcessAlive(proc.pid as number)).toBe(true);

			const reaped = await reapOrphans(registryDir);
			expect(reaped).toBe(1);
			await proc.wait();
			expect(isProcessAlive(proc.pid as number)).toBe(false);
		} finally {
			await cleanup();
		}
	});

	test("timeout hard-kills a stuck process", async () => {
		const { dir, cleanup } = await makeDir("workbench-supervisor-timeout");
		try {
			await writeFile(
				join(dir, "stuck.js"),
				"setInterval(() => {}, 1000);\n",
				"utf8",
			);
			const proc = spawnSupervised(`bun ${join(dir, "stuck.js")}`, {
				label: "stuck",
				timeoutSeconds: 1,
			});
			const outcome = await proc.wait();
			expect(outcome.timedOut).toBe(true);
			expect(outcome.killed).toBe(true);
		} finally {
			await cleanup();
		}
	});
});

describe("crash-loop breaker", () => {
	test("three abnormal exits inside the window trip the label", async () => {
		const { dir, cleanup } = await makeDir("workbench-supervisor-crash");
		try {
			const registryDir = join(dir, "proc");
			await writeFile(join(dir, "boom.js"), "process.exit(7);\n", "utf8");
			expect(crashLoopTripped(registryDir, "crashy")).toBe(false);
			for (let i = 0; i < 3; i += 1) {
				const proc = spawnSupervised(`bun ${join(dir, "boom.js")}`, {
					label: "crashy",
					registryDir,
				});
				const outcome = await proc.wait();
				expect(outcome.exitCode).toBe(7);
			}
			expect(crashLoopTripped(registryDir, "crashy")).toBe(true);
			// a clean exit does not count toward the breaker
			expect(crashLoopTripped(registryDir, "healthy")).toBe(false);
		} finally {
			await cleanup();
		}
	});
});
