import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBlackboard } from "../blackboard";
import { initWorkbench } from "../commands/init";
import type { AgentSession } from "./runner";
import { describeStreamLine, readAgentView, startAgent } from "./runner";

async function makeProject(): Promise<{
	projectDir: string;
	cleanup(): Promise<void>;
}> {
	const projectDir = join(
		tmpdir(),
		`workbench-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(projectDir, { recursive: true });
	await initWorkbench(projectDir);
	return {
		projectDir,
		cleanup: () => rm(projectDir, { recursive: true, force: true }),
	};
}

async function pollFor(
	predicate: () => Promise<boolean>,
	timeoutMs = 5000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("pollFor timed out");
}

describe("agent runner", () => {
	test("runs a fake agent in the worktree, captures stream, finishes done", async () => {
		const { projectDir, cleanup } = await makeProject();
		try {
			const bb = openBlackboard(join(projectDir, ".workbench"));
			await bb.goals.add({ title: "跑批目标" });
			await mkdir(join(projectDir, "worktrees", "ws-a"), { recursive: true });
			// fake agent: emits stream-json lines like claude -p does, exits 0
			await writeFile(
				join(projectDir, "worktrees", "ws-a", "fake-agent.js"),
				[
					'console.log(JSON.stringify({type:"system"}));',
					'console.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"任务完成，已落 checkpoint"}]}}));',
					'console.log(JSON.stringify({type:"result",result:"ok"}));',
					"process.exit(0);",
				].join("\n"),
				"utf8",
			);
			const config = await bb.config.load();
			config.agent.command = "bun fake-agent.js";
			await bb.config.save(config);
			await bb.state.workspots.save({
				id: "ws-a",
				branch: "ws/ws-a",
				worktreePath: join("worktrees", "ws-a"),
				primaryTask: "g-1",
				binding: "primary",
				status: "active",
				contextNeeds: { decisions: [], interfaces: [] },
			});

			const start = await startAgent(bb, {
				workspotId: "ws-a",
				prompt: "完成它",
			});
			expect(start.ok).toBe(true);

			await pollFor(async () => {
				const view = await readAgentView(bb, "ws-a");
				return view.session?.status === "done";
			});
			const { session, lastLines } = await readAgentView(bb, "ws-a");
			expect(session?.status).toBe("done");
			expect(session?.exitCode).toBe(0);
			expect(session?.prompt).toBe("完成它");
			expect(lastLines.some((line) => line.includes("任务完成"))).toBe(true);
			expect(lastLines.some((line) => line.startsWith("结果："))).toBe(true);

			// session log exists under .workbench/agents/ws-a/
			const logFile = (session as AgentSession).logFile;
			const raw = await readFile(logFile, "utf8");
			expect(raw).toContain("assistant");

			// events recorded
			const started = await bb.events.query({ type: "agent_started" });
			expect(started).toHaveLength(1);
			const finished = await bb.events.query({ type: "agent_finished" });
			expect(finished).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	test("failing agent command records failed status", async () => {
		const { projectDir, cleanup } = await makeProject();
		try {
			const bb = openBlackboard(join(projectDir, ".workbench"));
			await mkdir(join(projectDir, "worktrees", "ws-a"), { recursive: true });
			const config = await bb.config.load();
			config.agent.command = "bun fake.js";
			await bb.config.save(config);
			await bb.state.workspots.save({
				id: "ws-a",
				branch: "ws/ws-a",
				worktreePath: join("worktrees", "ws-a"),
				primaryTask: "g-1",
				binding: "primary",
				status: "active",
				contextNeeds: { decisions: [], interfaces: [] },
			});

			await startAgent(bb, { workspotId: "ws-a", prompt: "x" });
			await pollFor(async () => {
				const view = await readAgentView(bb, "ws-a");
				return view.session?.status === "failed";
			});
			const { session } = await readAgentView(bb, "ws-a");
			expect(session?.exitCode).not.toBe(0);
		} finally {
			await cleanup();
		}
	});

	test("describeStreamLine extracts assistant text and results", () => {
		expect(
			describeStreamLine(
				'{"type":"assistant","message":{"content":[{"type":"text","text":"你好"}]}}',
			),
		).toBe("你好");
		expect(describeStreamLine('{"type":"result","result":"done"}')).toBe(
			"结果：done",
		);
		expect(describeStreamLine("not json at all")).toBe("not json at all");
	});
});
