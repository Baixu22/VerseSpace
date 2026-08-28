import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeTempWorkbench, type TempWorkbench } from "../test/fixtures";
import type { Checkpoint } from "../types/checkpoint";
import type { Workspot } from "../types/workspot";
import { runDoctor } from "./index";

async function seedWorkspot(
	ws: TempWorkbench,
	id: string,
	taskId: string,
): Promise<Workspot> {
	const workspot: Workspot = {
		id,
		branch: `ws/${id}`,
		worktreePath: join("worktrees", id),
		primaryTask: taskId,
		binding: "primary",
		status: "idle",
		contextNeeds: { decisions: [], interfaces: [] },
	};
	await ws.bb.state.workspots.save(workspot);
	return workspot;
}

function checkpointOf(id: string, goal: string, workspot = "ws-a"): Checkpoint {
	return {
		id,
		goal,
		workspot,
		timestamp: new Date().toISOString(),
		lifecycle: "draft",
		assertion: "x",
		artifacts: [],
		unblocks: [],
	};
}

describe("runDoctor", () => {
	test("a fresh workspace is clean", async () => {
		const ws = await makeTempWorkbench();
		try {
			const report = await runDoctor(ws.bb);
			expect(report).toEqual({ ok: true, issues: [] });
		} finally {
			await ws.cleanup();
		}
	});

	test("detects dangling dependency and dangling queue entry", async () => {
		const ws = await makeTempWorkbench();
		try {
			const goal = await ws.bb.goals.add({
				title: "A",
				dependsOn: ["g-ghost"],
			});
			await ws.bb.state.queue.enqueue(goal.id);

			const report = await runDoctor(ws.bb);
			const checks = report.issues.map((issue) => issue.check);
			expect(checks).toContain("dangling_dependency");
			// queued goal is planned, not ready → stale entry warning too
			expect(checks).toContain("stale_queue_entry");
			expect(report.ok).toBe(false);
		} finally {
			await ws.cleanup();
		}
	});

	test("detects orphan checkpoint and dangling checkpoint reference", async () => {
		const ws = await makeTempWorkbench();
		try {
			const goal = await ws.bb.goals.add({ title: "A", dependsOn: [] });
			await ws.bb.checkpoints.save(
				checkpointOf("cp-orphan", "g-ghost"),
				"staging",
			);
			await ws.bb.goals.update(goal.id, { checkpoints: ["cp-vanished"] });

			const report = await runDoctor(ws.bb);
			const checks = report.issues.map((issue) => issue.check);
			expect(checks).toContain("orphan_checkpoint");
			expect(checks).toContain("dangling_checkpoint_reference");
		} finally {
			await ws.cleanup();
		}
	});

	test("detects workspot pointing at a missing goal", async () => {
		const ws = await makeTempWorkbench();
		try {
			await seedWorkspot(ws, "ws-a", "g-ghost");
			const report = await runDoctor(ws.bb);
			expect(report.issues.map((issue) => issue.check)).toContain(
				"dangling_workspot_task",
			);
			expect(report.ok).toBe(false);
		} finally {
			await ws.cleanup();
		}
	});

	test("detects interface drift and missing interface file", async () => {
		const ws = await makeTempWorkbench();
		try {
			const { mkdir, writeFile, appendFile } = await import("node:fs/promises");
			const contract = join(ws.projectDir, "contracts", "api.md");
			await mkdir(join(ws.projectDir, "contracts"), { recursive: true });
			await writeFile(contract, "# api v1\n", "utf8");
			const { hashFile } = await import("../hash");
			await ws.bb.interfaces.register({
				key: "core/api",
				canonicalPath: "contracts/api.md",
				version: 1,
				publishedBy: "human",
				lastModified: new Date().toISOString(),
				contentHash: await hashFile(contract),
				subscribers: [],
			});
			await appendFile(contract, "\n# changed\n", "utf8");

			const drifted = await runDoctor(ws.bb);
			expect(drifted.issues.map((issue) => issue.check)).toContain(
				"interface_drift",
			);

			const { rm } = await import("node:fs/promises");
			await rm(contract);
			const missing = await runDoctor(ws.bb);
			expect(missing.issues.map((issue) => issue.check)).toContain(
				"missing_interface_file",
			);
			expect(missing.ok).toBe(false);
		} finally {
			await ws.cleanup();
		}
	});

	test("detects duplicate queue entries and auto policy without a cap", async () => {
		const ws = await makeTempWorkbench();
		try {
			const goal = await ws.bb.goals.add({ title: "A" });
			await ws.bb.goals.update(goal.id, { status: "ready" });
			// duplicate by writing the file directly through the state API twice
			await ws.bb.state.queue.enqueue(goal.id);
			const { readFile, writeFile } = await import("node:fs/promises");
			const queuePath = join(
				ws.projectDir,
				".workbench",
				"blackboard",
				"state",
				"queue.yaml",
			);
			const raw = await readFile(queuePath, "utf8");
			await writeFile(
				queuePath,
				raw.replace("queue:", `queue:\n  - ${goal.id}`),
				"utf8",
			);

			const report = await runDoctor(ws.bb);
			expect(report.issues.map((issue) => issue.check)).toContain(
				"duplicate_queue_entry",
			);

			const config = await ws.bb.config.load();
			config.scheduler.policy = "auto";
			config.scheduler.autoConstraints = undefined;
			await ws.bb.config.save(config);
			const autoReport = await runDoctor(ws.bb);
			expect(autoReport.issues.map((issue) => issue.check)).toContain(
				"auto_without_cap",
			);
		} finally {
			await ws.cleanup();
		}
	});

	test("draft without verification is a warning, not an error", async () => {
		const ws = await makeTempWorkbench();
		try {
			const goal = await ws.bb.goals.add({ title: "A" });
			await ws.bb.checkpoints.save(checkpointOf("cp-1", goal.id), "staging");
			const report = await runDoctor(ws.bb);
			expect(report.issues.map((issue) => issue.check)).toContain(
				"draft_without_verification",
			);
			expect(report.ok).toBe(true);
		} finally {
			await ws.cleanup();
		}
	});
});
