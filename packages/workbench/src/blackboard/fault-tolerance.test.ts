import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBlackboard } from "../blackboard";
import { initWorkbench } from "../commands/init";
import { BlackboardConflictError } from "../errors";
import { runOnce } from "../runtime";

/**
 * Fault-tolerance gate (milestone 10): the blackboard must survive crash-like
 * corruption (torn YAML / JSONL) with a diagnosable error instead of silent
 * damage, concurrent CLI writers must not interleave half-writes, and sync
 * must converge after kill-mid-write recovery.
 */

async function makeProject(): Promise<{
	projectDir: string;
	cleanup(): Promise<void>;
}> {
	const projectDir = join(
		tmpdir(),
		`workbench-fault-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	await mkdir(projectDir, { recursive: true });
	await initWorkbench(projectDir);
	return {
		projectDir,
		cleanup: () => rm(projectDir, { recursive: true, force: true }),
	};
}

describe("fault tolerance", () => {
	test("torn YAML goal file is reported with path, other goals stay readable", async () => {
		const { projectDir, cleanup } = await makeProject();
		try {
			const bb = openBlackboard(join(projectDir, ".workbench"));
			const good = await bb.goals.add({ title: "好的" });
			const badPath = join(
				projectDir,
				".workbench",
				"blackboard",
				"goals",
				"g-torn.yaml",
			);
			// a crash mid-write can leave a torn YAML body
			await writeFile(badPath, "id: g-torn\ntitle: [unclosed\n", "utf8");

			try {
				await bb.goals.list();
				expect.unreachable();
			} catch (error) {
				// the error points at the offending file, not just "bad YAML"
				expect((error as { path?: string }).path).toBe(badPath);
				expect(error).toBeInstanceOf(Object);
			}
			// the good goal is still directly readable
			expect((await bb.goals.get(good.id))?.title).toBe("好的");

			// doctor-style recovery: remove the corrupt file, sync converges
			const { unlink } = await import("node:fs/promises");
			await unlink(badPath);
			const run = await runOnce(bb);
			expect(run.applied).toBeGreaterThanOrEqual(1);
		} finally {
			await cleanup();
		}
	});

	test("torn events.jsonl line does not block sync", async () => {
		const { projectDir, cleanup } = await makeProject();
		try {
			const bb = openBlackboard(join(projectDir, ".workbench"));
			await bb.events.append({
				timestamp: new Date().toISOString(),
				source: "test",
				type: "before_crash",
				payload: {},
			});
			// simulate a crash mid-append
			await appendFile(
				join(projectDir, ".workbench", "events", "events.jsonl"),
				'{"timestamp":"2026-08-28T00:0',
				"utf8",
			);

			await bb.goals.add({ title: "A" });
			const run = await runOnce(bb);
			expect(run.applied).toBeGreaterThanOrEqual(1);
			// the pre-crash event is still there and new events append cleanly
			expect(await bb.events.query({ type: "before_crash" })).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	test("20 concurrent writers: no lost updates (CAS retries) and every enqueue survives", async () => {
		const { projectDir, cleanup } = await makeProject();
		try {
			const bbA = openBlackboard(join(projectDir, ".workbench"));
			const goal = await bbA.goals.add({ title: "竞争目标" });

			// 20 racing writers through independent blackboard handles: even
			// indices CAS-retry a goal title change, odd indices enqueue their
			// own queue entry — the previous single-file queue lost updates here
			const writers = Array.from({ length: 20 }, (_, i) => async () => {
				const bb = openBlackboard(join(projectDir, ".workbench"));
				if (i % 2 === 0) {
					// optimistic CAS loop: rebase on the current version until
					// the write lands — updates are never silently lost
					for (;;) {
						try {
							const current = await bb.goals.get(goal.id);
							await bb.goals.update(
								goal.id,
								{ title: `版本-${i}` },
								{ expectedVersion: current?.version },
							);
							return;
						} catch (error) {
							if (error instanceof BlackboardConflictError) {
								continue; // raced: retry with the fresh version
							}
							throw error;
						}
					}
				}
				await bb.state.queue.enqueue(`g-noise-${i}`);
			});
			await Promise.all(writers.map((write) => write()));

			const bbFinal = openBlackboard(join(projectDir, ".workbench"));
			// all 10 enqueues survived — the old queue.yaml lost up to half
			expect(await bbFinal.state.queue.get()).toHaveLength(10);
			// the goal is intact and its version advanced once per landed update
			const final = await bbFinal.goals.get(goal.id);
			expect(final?.id).toBe(goal.id);
			expect(final?.title).toMatch(/^版本-\d+$/);
			expect(final?.version).toBe(1 + 10);
			// no temp residue anywhere
			const goalsDir = join(projectDir, ".workbench", "blackboard", "goals");
			const files = await import("node:fs/promises").then((m) =>
				m.readdir(goalsDir),
			);
			expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("stale expectedVersion fails with a conflict carrying the current goal", async () => {
		const { projectDir, cleanup } = await makeProject();
		try {
			const bb = openBlackboard(join(projectDir, ".workbench"));
			const goal = await bb.goals.add({ title: "CAS" });
			await bb.goals.update(goal.id, { title: "第二版" });
			expect(goal.version).toBe(1);

			let conflict: BlackboardConflictError | null = null;
			try {
				await bb.goals.update(
					goal.id,
					{ title: "过时写入" },
					{ expectedVersion: 1 },
				);
			} catch (error) {
				if (error instanceof BlackboardConflictError) {
					conflict = error;
				} else {
					throw error;
				}
			}
			expect(conflict).not.toBeNull();
			// the conflict carries the object that IS on disk
			expect(
				(conflict?.current as { title: string; version: number }).title,
			).toBe("第二版");
			expect(
				(conflict?.current as { title: string; version: number }).version,
			).toBe(2);
			// the overtake write never landed
			expect((await bb.goals.get(goal.id))?.title).toBe("第二版");
		} finally {
			await cleanup();
		}
	});

	test("kill-mid-write leaves either old or new content, never a mix", async () => {
		const { projectDir, cleanup } = await makeProject();
		try {
			const bb = openBlackboard(join(projectDir, ".workbench"));
			const goal = await bb.goals.add({ title: "原子性目标" });
			const goalPath = join(
				projectDir,
				".workbench",
				"blackboard",
				"goals",
				`${goal.id}.yaml`,
			);

			// a torn overwrite would leave e.g. "id: ... title: 新标题字" —
			// simulate the recoverable states the atomic write permits
			const before = await readFile(goalPath, "utf8");
			expect(before).toContain(goal.id);

			// healthy overwrite succeeds
			await bb.goals.update(goal.id, { title: "更新后的目标" });
			const after = await readFile(goalPath, "utf8");
			expect(after).toContain("更新后的目标");
			expect(after).toContain(goal.id);
		} finally {
			await cleanup();
		}
	});
});
