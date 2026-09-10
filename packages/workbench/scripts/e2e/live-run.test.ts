import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("后段失败保留集成阶段检查点和明细，整轮仍失败且错误脱敏", async () => {
	const root = await mkdtemp(join(tmpdir(), "live-report-test-"));
	const modulePath = (file: string) =>
		JSON.stringify(resolve(import.meta.dir, file));
	// Mock the coordinator's stages in a separate process so other E2Es keep
	// their real CLI/server modules and this check never reaches a provider.
	const script = `
		import { mock } from "bun:test";
		mock.module(${modulePath("scenario.ts")}, () => ({
			makeTempWorkspace: async () => ({ projectDir: process.env.LIVE_REPORT_ROOT }),
			runE2E: async () => ({
				ok: true, projectDir: process.env.LIVE_REPORT_ROOT,
				steps: [{ step: "S6c", ok: true, detail: { folded: 3 } }],
				stats: { threads: 3 }, ledgerT0: { started: true }, sampleWindow: null
			})
		}));
		mock.module(${modulePath("live-development.ts")}, () => ({
			runLiveDevelopment: async () => { throw new Error("development failed test-key"); }
		}));
		mock.module(${modulePath("live-fork.ts")}, () => ({
			runLiveFork: async () => { throw new Error("fork must not run"); }
		}));
		await import(${modulePath("live-run.ts")});
	`;
	try {
		const attempt = { attempt: 1, status: 429, outcome: "http-error" };
		const agentDir = join(root, ".workbench/live-agent");
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "attempts.jsonl"),
			`${JSON.stringify(attempt)}\n`,
		);
		const child = Bun.spawn([process.execPath, "-e", script], {
			env: {
				...process.env,
				E2E_LLM_KEY: "test-key",
				E2E_LLM_MODEL: "test-model",
				LIVE_REPORT_ROOT: root,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [code, output, error] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(code).toBe(1);
		const integration = JSON.parse(
			await readFile(join(root, "runs/live-integration.json"), "utf8"),
		);
		const report = JSON.parse(
			await readFile(join(root, "runs/live-report.json"), "utf8"),
		);
		expect(integration.ok).toBe(true);
		expect(report.ok).toBe(false);
		expect(report.steps).toEqual(integration.steps);
		expect(report.stats).toEqual(integration.stats);
		expect(report.error).toBe("Error: development failed [REDACTED]");
		expect(report.attempts).toEqual([attempt]);
		expect(report.calls).toEqual([]);
		expect(output).toContain("请求尝试 1 次");
		expect(`${output}${error}${JSON.stringify(report)}`).not.toContain(
			"test-key",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
