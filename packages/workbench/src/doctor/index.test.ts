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
			await ws.bb.state.queue.enqueue(goal.id);
			// corruption vector: a second entry file naming the same goal —
			// the queue directory now holds one file per entry, so a duplicate
			// can only appear as a crafted stray file
			const { writeFile, mkdir } = await import("node:fs/promises");
			const queueDir = join(
				ws.projectDir,
				".workbench",
				"blackboard",
				"state",
				"queue",
			);
			await mkdir(queueDir, { recursive: true });
			await writeFile(
				join(queueDir, `${goal.id}.stray.yaml`),
				`goalId: ${goal.id}\nseq: 999\n`,
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

	test("detects dangling adopt snapshot and half-adopted source (TF-0200)", async () => {
		const ws = await makeTempWorkbench();
		try {
			const { mkdir, writeFile } = await import("node:fs/promises");
			const writeThread = async (meta: Record<string, unknown>) => {
				const dir = join(ws.workbenchRoot, "threads", meta.id as string);
				await mkdir(dir, { recursive: true });
				await writeFile(
					join(dir, "meta.json"),
					JSON.stringify(meta, null, 2),
					"utf8",
				);
			};
			const snapshot = {
				id: "snap-1",
				version: 1,
				sourceThreadId: "thread-src",
				sourceArchivedBefore: false,
				adoptedThreadId: "thread-child",
				adoptedForkOfBefore: {
					sourceThreadId: "thread-src",
					sourceTitle: "源",
					anchorMessageId: "m-1",
					inheritedMessages: 1,
					at: new Date().toISOString(),
				},
				adoptedArchivedBefore: false,
				anchorMessageId: "m-1",
				at: new Date().toISOString(),
			};

			// 悬空快照：快照挂在一个未归档的线程上（revert 半途 / 手改 meta）
			await writeThread({
				id: "thread-dangling",
				title: "悬空",
				createdAt: new Date().toISOString(),
				status: "idle",
				permissionMode: "default",
				archived: false,
				adoptSnapshot: snapshot,
			});

			// 半收养：源线程无 adoptSnapshot，却存在 thread.adopted 事件且无反转事件
			await writeThread({
				id: "thread-src",
				title: "源",
				createdAt: new Date().toISOString(),
				status: "idle",
				permissionMode: "default",
			});
			await ws.bb.events.appendThread("thread.adopted", {
				newMainThreadId: "thread-child",
				sourceThreadId: "thread-src",
				anchorMessageId: "m-1",
				snapshotVersion: 1,
				threadId: "thread-child",
			});

			const report = await runDoctor(ws.bb);
			const checks = report.issues.map((issue) => issue.check);
			expect(checks).toContain("dangling_adopt_snapshot");
			expect(checks).toContain("half_adopted");
			// 悬空快照是 error，半收养是 warning → 报告整体不 ok
			expect(report.ok).toBe(false);

			// 反转后：源线程重挂快照或事件落地 thread.adoption_reverted，半收养消失
			await ws.bb.events.appendThread("thread.adoption_reverted", {
				sourceThreadId: "thread-src",
				adoptedThreadId: "thread-child",
				snapshotId: "snap-1",
				threadId: "thread-src",
			});
			const afterRevert = await runDoctor(ws.bb);
			expect(afterRevert.issues.map((i) => i.check)).not.toContain(
				"half_adopted",
			);
		} finally {
			await ws.cleanup();
		}
	});

	test("a corrupt meta.json is reported, not swallowed as an empty thread list (P-audit)", async () => {
		const ws = await makeTempWorkbench();
		try {
			const { mkdir, writeFile } = await import("node:fs/promises");
			// One good thread and one whose meta.json is not valid JSON. The old
			// private re-listing dropped the corrupt one to null and read it as
			// "no such thread", so doctor greenlit a corrupt ledger. It must now
			// surface as an error and flip report.ok.
			const good = join(ws.workbenchRoot, "threads", "thread-good");
			await mkdir(good, { recursive: true });
			await writeFile(
				join(good, "meta.json"),
				JSON.stringify({
					id: "thread-good",
					title: "好",
					createdAt: new Date().toISOString(),
					status: "idle",
					permissionMode: "default",
				}),
				"utf8",
			);
			const broken = join(ws.workbenchRoot, "threads", "thread-broken");
			await mkdir(broken, { recursive: true });
			await writeFile(join(broken, "meta.json"), "{ not valid json", "utf8");

			const report = await runDoctor(ws.bb);
			const broke = report.issues.find(
				(issue) => issue.check === "thread_meta_unreadable",
			);
			expect(broke?.subject).toBe("thread-broken");
			expect(broke?.severity).toBe("error");
			expect(report.ok).toBe(false);
		} finally {
			await ws.cleanup();
		}
	});

	test("old checkpoints without thread/writer link parse and stay clean (TF-0196)", async () => {
		const ws = await makeTempWorkbench();
		try {
			const goal = await ws.bb.goals.add({ title: "A" });
			await seedWorkspot(ws, "ws-a", goal.id);
			// 旧数据形状：无 threadId/writerId。可选字段缺失必须照常解析，
			// doctor 不得因缺失会话链接而报错。
			const legacy: Checkpoint = {
				...checkpointOf("cp-legacy", goal.id),
				verification: { strategy: "test", command: "bun test", timeout: 60 },
			};
			await ws.bb.checkpoints.save(legacy, "staging");
			// 新形状：带会话链接。两种形状并存时 doctor 同样不报错。
			const linked: Checkpoint = {
				...checkpointOf("cp-linked", goal.id),
				verification: { strategy: "test", command: "bun test", timeout: 60 },
				threadId: "thread-1",
				writerId: "thread-1",
			};
			await ws.bb.checkpoints.save(linked, "staging");
			const report = await runDoctor(ws.bb);
			expect(report).toEqual({ ok: true, issues: [] });
			const all = await ws.bb.checkpoints.scanZone("staging");
			expect(all.find((c) => c.id === "cp-legacy")?.threadId).toBeUndefined();
			expect(all.find((c) => c.id === "cp-linked")?.threadId).toBe("thread-1");
		} finally {
			await ws.cleanup();
		}
	});
});
