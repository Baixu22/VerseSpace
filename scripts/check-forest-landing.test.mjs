import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("a detached acceptance worktree reports real branch drift, never treats '(no branch)' as a ref", () => {
	const root = mkdtempSync(join(tmpdir(), "wb-landing-test-"));
	const git = (...args) =>
		execFileSync(
			"git",
			[
				"-c",
				"core.hooksPath=",
				"-c",
				"user.name=test",
				"-c",
				"user.email=test@example.invalid",
				...args,
			],
			{ cwd: root, stdio: "pipe" },
		);
	try {
		mkdirSync(join(root, "scripts"));
		copyFileSync(
			new URL("./check-forest-landing.mjs", import.meta.url),
			join(root, "scripts/check-forest-landing.mjs"),
		);
		mkdirSync(join(root, ".agent-workbench/task-forest/graph"), {
			recursive: true,
		});
		writeFileSync(
			join(root, ".agent-workbench/task-forest/graph/nodes.json"),
			"{}",
		);
		git("init", "-q", "-b", "main");
		git("add", ".");
		git("commit", "-qm", "baseline");
		git("checkout", "-q", "--detach");
		writeFileSync(join(root, "code.ts"), "export const value = 1;");
		git("add", "code.ts");
		git("commit", "-qm", "detached candidate");
		const result = spawnSync(
			process.execPath,
			["scripts/check-forest-landing.mjs", "--json"],
			{ cwd: root, encoding: "utf8" },
		);
		assert.equal(result.status, 1);
		const report = JSON.parse(result.stdout);
		assert.equal(report.status, "drift");
		assert.ok(
			report.problems.some((problem) => problem.includes("HEAD 领先 main 1")),
		);
		assert.ok(!result.stderr.includes("(no branch)"));
	} finally {
		rmSync(root, {
			recursive: true,
			force: true,
			maxRetries: 40,
			retryDelay: 250,
		});
	}
});
