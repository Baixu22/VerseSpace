import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../../src/test/fixtures";

/** CI runner may launch bun via a .cmd shim; spawnSync needs a real .exe. */
function resolveBun(): string {
	const candidates = [
		process.env.BUN_BIN ? join(process.env.BUN_BIN, "bun.exe") : "",
		join(process.env.APPDATA ?? "", "npm/node_modules/bun/bin/bun.exe"),
		"C:\\Users\\27933\\AppData\\Roaming\\npm\\node_modules\\bun\\bin\\bun.exe",
		process.execPath,
	].filter((p): p is string => Boolean(p));
	for (const candidate of candidates) {
		try {
			if (existsSync(candidate) && candidate.endsWith(".exe")) {
				return candidate;
			}
		} catch {
			// try next
		}
	}
	return process.execPath;
}

test("代理自审不能宣称 L1 真人验收达标，真实人答通道单独计数", async () => {
	const ws = await makeTempWorkbench();
	try {
		await mkdir(join(ws.projectDir, "src"));
		await writeFile(
			join(ws.projectDir, "src/core.ts"),
			"export const core = 1;\n",
		);
		await ws.bb.sessions.register("writer", "agent", "测试会话");
		await ws.bb.sessions.recordActivity("writer", {
			activity: "edit-core",
			agent: "writer",
			used: [],
			generated: [{ path: "src/core.ts" }],
		});
		const answers = join(ws.projectDir, "answers.json");
		await writeFile(
			answers,
			JSON.stringify([
				{ writer: "writer", handle: "src/core.ts", verdict: "endorse" },
			]),
		);
		const bunBin = resolveBun();
		const script = join(import.meta.dir, "landmark-review-queue.ts");
		const apply = (...flags: string[]) =>
			spawnSync(
				bunBin,
				[
					script,
					"--workspace",
					ws.projectDir,
					"--all-sessions",
					"--apply",
					answers,
					...flags,
				],
				{
					encoding: "utf8",
					windowsHide: true,
					timeout: 30_000,
					// CI runner PATH may omit git/node; keep the spawn hermetic.
					env: {
						...process.env,
						PATH: [
							"C:\\Program Files\\Git\\cmd",
							"C:\\Program Files\\nodejs",
							join(process.env.BUN_BIN ?? "", ""),
							...String(process.env.PATH ?? "").split(";"),
						]
							.filter(Boolean)
							.join(";"),
					},
				},
			);
		const steward = apply("--steward");
		expect(
			steward.status,
			`bun=${bunBin}\nscript=${script}\nerror=${steward.error}\nstatus=${steward.status}\nstderr=${steward.stderr}\nstdout=${steward.stdout}`,
		).toBe(0);
		expect(steward.stdout).toContain("认可 1 / 全部候选 1 = 1.0000");
		expect(steward.stdout).toContain(
			"用户认可口径（human · 新口径）：认可 0 / 全部候选 1",
		);
		expect(steward.stdout).not.toContain("已满足，可据此收口");
		expect(
			await ws.bb.events.query({ source: "human", type: "landmark.reviewed" }),
		).toHaveLength(0);

		// Only the isolated test blackboard receives this synthetic human fixture.
		const human = apply();
		expect(
			human.status,
			`bun=${bunBin}\nerror=${human.error}\nstatus=${human.status}\nstderr=${human.stderr}\nstdout=${human.stdout}`,
		).toBe(0);
		expect(human.stdout).toContain("已满足，可据此收口");
		expect(
			await ws.bb.events.query({ source: "human", type: "landmark.reviewed" }),
		).toHaveLength(1);
	} finally {
		await ws.cleanup();
	}
});
