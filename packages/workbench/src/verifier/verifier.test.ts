import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_COMMANDS, runVerification } from "./index";

let worktree: string;

beforeEach(async () => {
	worktree = join(
		tmpdir(),
		`workbench-verify-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(worktree, { recursive: true });
});

afterEach(async () => {
	await rm(worktree, { recursive: true, force: true });
});

/** Write a script into the fake worktree and return its shell command. */
async function script(code: string): Promise<string> {
	await writeFile(join(worktree, "script.js"), code, "utf8");
	return "bun script.js";
}

describe("runVerification", () => {
	test("no strategy is skipped without executing anything", async () => {
		const result = await runVerification(undefined, worktree);
		expect(result).toEqual({
			status: "skipped",
			reason: "该 checkpoint 没有 verification 策略",
		});
	});

	test("human-review returns needs_human without executing", async () => {
		const result = await runVerification(
			{ strategy: "human-review" },
			worktree,
		);
		expect(result.status).toBe("needs_human");
	});

	test("passing command yields passed", async () => {
		const command = await script("console.log('all green');\n");
		const result = await runVerification(
			{ strategy: "test", command },
			worktree,
		);
		expect(result).toEqual({ status: "passed" });
	});

	test("non-zero exit yields failed with captured output", async () => {
		const command = await script("console.error('boom');\nprocess.exit(1);\n");
		const result = await runVerification(
			{ strategy: "test", command },
			worktree,
		);
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.output).toContain("boom");
		}
	});

	test("expectedExitCode overrides the default zero", async () => {
		const command = await script("process.exit(3);\n");
		const result = await runVerification(
			{ strategy: "test", command, expectedExitCode: 3 },
			worktree,
		);
		expect(result).toEqual({ status: "passed" });
	});

	test("executes inside the worktree (cwd)", async () => {
		// surface the cwd through stderr on a failing run so it lands in output
		const command = await script(
			'console.error(process.cwd().replace(/\\\\/g, "/").toLowerCase());\nprocess.exit(1);\n',
		);
		const result = await runVerification(
			{ strategy: "test", command },
			worktree,
		);
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.output).toContain(
				worktree.replace(/\\/g, "/").toLowerCase(),
			);
		}
	});

	test("timeout hard-kills the process and reports timeout", async () => {
		const command = await script(
			"console.log('hang');\nawait new Promise((resolve) => setTimeout(resolve, 30_000));\n",
		);
		const started = Date.now();
		const result = await runVerification(
			{ strategy: "test", command, timeout: 1 },
			worktree,
		);
		expect(result.status).toBe("timeout");
		// killed at ~1s, not at 30s
		expect(Date.now() - started).toBeLessThan(10_000);
	}, 20_000);

	test("oversized failure output is truncated for archival", async () => {
		const command = await script(
			"console.log('x'.repeat(100_000));\nprocess.exit(1);\n",
		);
		const result = await runVerification(
			{ strategy: "test", command },
			worktree,
		);
		expect(result.status).toBe("failed");
		if (result.status === "failed") {
			expect(result.output.length).toBeLessThanOrEqual(21_000);
			expect(result.output).toContain("输出已截断");
		}
	});

	test("strategy defaults are wired (documented fallbacks)", () => {
		expect(DEFAULT_COMMANDS.test).toBe("bun test");
		expect(DEFAULT_COMMANDS["type-check"]).toBe("bunx tsc --noEmit");
		expect(DEFAULT_COMMANDS.build).toBe("bun run build");
	});
});
