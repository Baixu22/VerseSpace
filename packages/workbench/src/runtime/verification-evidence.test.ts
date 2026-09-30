import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildBranchL1Summary } from "../chat/resume-card/l1-summary";
import { initGitFixture, makeTempWorkbench } from "../test/fixtures";
import { checkpointSchema } from "../types/checkpoint";
import { workspotSchema } from "../types/workspot";
import { runOnce } from "./index";
import { checkpointVerificationStatus } from "./verification-status";

function report(
	names = ["contract reads", "contract writes"],
	status = "passed",
) {
	return {
		numTotalTests: names.length,
		numPassedTests: status === "passed" ? names.length : 0,
		numFailedTests: status === "failed" ? names.length : 0,
		numPendingTests: status === "pending" ? names.length : 0,
		success: status === "passed",
		testResults: [
			{ assertionResults: names.map((fullName) => ({ fullName, status })) },
		],
	};
}

async function seed(kind = "complete") {
	const ws = await makeTempWorkbench();
	initGitFixture(ws.projectDir);
	await writeFile(
		join(ws.projectDir, ".gitignore"),
		".workbench/\nconfig.local.json\n",
	);
	await writeFile(join(ws.projectDir, "config.local.json"), '{"mode":"a"}');
	const payload =
		kind === "zero"
			? report([])
			: kind === "subset"
				? report(["contract reads"])
				: kind === "skip"
					? report(undefined, "pending")
					: kind === "duplicate"
						? report(["contract reads", "contract reads"])
						: report();
	const content = kind === "damaged" ? "{truncated" : JSON.stringify(payload);
	const script =
		kind === "missing" || kind === "old"
			? "process.exit(0);"
			: `require('node:fs').writeFileSync('report.json', ${JSON.stringify(content)});`;
	await writeFile(
		join(ws.projectDir, "check.cjs"),
		script +
			(kind === "during"
				? `require('node:fs').writeFileSync('config.local.json', '{}');`
				: ""),
	);
	if (kind === "old")
		await writeFile(join(ws.projectDir, "report.json"), content);
	const goal = await ws.bb.goals.add(
		{ title: "declared check" },
		"in_progress",
	);
	await ws.bb.state.workspots.save(
		workspotSchema.parse({
			id: "ws",
			branch: "main",
			worktreePath: ws.projectDir,
			status: "active",
			primaryTask: goal.id,
		}),
	);
	await ws.bb.checkpoints.save(
		checkpointSchema.parse({
			id: "cp",
			goal: goal.id,
			workspot: "ws",
			threadId: "thread",
			timestamp: new Date().toISOString(),
			lifecycle: "draft",
			assertion: "all declared tests",
			verification: {
				strategy: "test",
				command: `"${process.execPath}" check.cjs`,
				evidence: {
					report: {
						format: "vitest-json",
						path: "report.json",
						expectedTests: ["contract reads", "contract writes"],
					},
					inputs: ["config.local.json"],
				},
			},
		}),
		"staging",
	);
	return ws;
}

test.each([
	"zero",
	"subset",
	"skip",
	"duplicate",
	"missing",
	"damaged",
	"old",
])("exit 0 with %s report cannot satisfy the declared scope", async (kind) => {
	const ws = await seed(kind);
	try {
		await runOnce(ws.bb);
		const cp = (await ws.bb.checkpoints.scanZone("staging"))[0]!;
		expect(cp.lifecycle).toBe("awaiting_review");
		expect(cp.verificationResult?.status).toBe("passed");
		expect(cp.verificationResult?.exitCode).toBe(0);
		expect(cp.verificationResult?.evidence?.status).not.toBe("satisfied");
		expect(cp.verificationBinding).toBeUndefined();
		expect(cp.verificationBindingIssue).toContain("验证范围未满足");
		await runOnce(ws.bb);
		expect(
			await ws.bb.events.query({ type: "request_verification" }),
		).toHaveLength(1);
	} finally {
		await ws.cleanup();
	}
});

test("complete scope reaches JSON/restore; ignored config drift invalidates it", async () => {
	const ws = await seed();
	try {
		await runOnce(ws.bb);
		const cp = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
		expect(cp.verificationResult?.evidence?.counts).toEqual({
			total: 2,
			passed: 2,
			failed: 0,
			skipped: 0,
		});
		expect(cp.verificationBinding?.files["report.json"]).toBeUndefined();
		expect(
			cp.verificationBinding?.context?.evidence?.inputs["config.local.json"],
		).toMatch(/^[a-f0-9]{64}$/);
		const cli = spawnSync(
			process.execPath,
			[resolve(import.meta.dir, "../index.ts"), "checkpoint", "list", "--json"],
			{ cwd: ws.projectDir, encoding: "utf8" },
		);
		expect(cli.status).toBe(0);
		expect(
			JSON.parse(cli.stdout).verified[0].verificationResult.evidence.status,
		).toBe("satisfied");
		const summary = await buildBranchL1Summary({
			bb: ws.bb,
			branch: { id: "thread", title: "work" },
			events: [],
			isAfterLeave: () => true,
			counterpartyWrites: new Set(),
		});
		expect(
			summary.lines.find((line) => line.kind === "verifier")?.text,
		).toContain("声明范围 2/2");
		await runOnce(ws.bb);
		expect((await ws.bb.checkpoints.scanZone("verified"))[0]?.lifecycle).toBe(
			"applied",
		);
		await writeFile(join(ws.projectDir, "config.local.json"), '{"mode":"b"}');
		expect(
			(
				await checkpointVerificationStatus(ws.bb, {
					...cp,
					lifecycle: "applied",
				})
			).status,
		).toBe("stale");
		expect(cp.verificationResult?.evidence?.status).toBe("satisfied");
	} finally {
		await ws.cleanup();
	}
});

test("ignored configuration changed during verification cannot get a binding", async () => {
	const ws = await seed("during");
	try {
		await runOnce(ws.bb);
		const cp = (await ws.bb.checkpoints.scanZone("staging"))[0]!;
		expect(cp.verificationResult?.evidence?.status).toBe("satisfied");
		expect(cp.lifecycle).toBe("awaiting_review");
		expect(cp.verificationBindingIssue).toContain("配置输入");
	} finally {
		await ws.cleanup();
	}
});
