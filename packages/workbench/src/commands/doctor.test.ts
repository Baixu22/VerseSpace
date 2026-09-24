import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { doctorCommand } from "./doctor";

/**
 * P0-3：AGENTS.md 说 `doctor` 的非零退出码让它「可作为 CI 闸门」，但在这次
 * 改动之前**没有任何测试钉住那个退出码**——`doctor/index.test.ts` 只断言
 * `report.ok`，`cli.test.ts` 只检查命令存在。`commands/doctor.ts` 里那行
 * `process.exitCode = rotFailed || blackboardFailed ? 1 : 0` 改坏了也不会红。
 * 这两个用例把闸门本身钉住：该红的时候红，不该红的时候不红。
 */

const jsonCommand = {
	optsWithGlobals: () => ({ json: true }),
} as unknown as Command;

const originalCwd = process.cwd();

async function inTempDir(run: (dir: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "workbench-doctor-"));
	try {
		await run(dir);
	} finally {
		process.chdir(originalCwd);
		process.exitCode = 0;
		await rm(dir, { recursive: true, force: true });
	}
}

describe("doctor 的退出码（P0-3：CI 闸门有测试钉住）", () => {
	test("指令文件里有失效引用时退出码是 1", async () => {
		await inTempDir(async (dir) => {
			await writeFile(
				join(dir, "AGENTS.md"),
				"see `src/does-not-exist.ts` for the thing\n",
				"utf8",
			);
			process.chdir(dir);
			process.exitCode = 0;

			await doctorCommand(jsonCommand);

			expect(process.exitCode).toBe(1);
		});
	});

	test("没有失效引用时退出码是 0，不误报", async () => {
		await inTempDir(async (dir) => {
			await writeFile(
				join(dir, "AGENTS.md"),
				"this file cites no paths at all\n",
				"utf8",
			);
			process.chdir(dir);
			process.exitCode = 0;

			await doctorCommand(jsonCommand);

			expect(process.exitCode).toBe(0);
		});
	});
});
