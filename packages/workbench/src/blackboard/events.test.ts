import { describe, expect, test } from "bun:test";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { openBlackboard } from "./index";

function event(type: string, n: number) {
	return {
		timestamp: new Date(Date.UTC(2026, 7, 28, 0, 0, n)).toISOString(),
		source: "runtime",
		type,
		payload: { n },
	};
}

describe("events blackboard API", () => {
	test("append + tail", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			expect(await bb.events.tail(5)).toEqual([]);

			for (let i = 0; i < 5; i++) {
				await bb.events.append(event("runtime_cycle", i));
			}
			const tail = await bb.events.tail(2);
			expect(tail.map((e) => (e.payload as { n: number }).n)).toEqual([3, 4]);
		} finally {
			await cleanup();
		}
	});

	test("query filters by type and source with limit", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			for (let i = 0; i < 4; i++) {
				await bb.events.append(event("runtime_cycle", i));
			}
			await bb.events.append({
				...event("checkpoint_moved", 99),
				source: "blackboard",
			});

			const moved = await bb.events.query({ type: "checkpoint_moved" });
			expect(moved).toHaveLength(1);
			expect(moved[0]?.source).toBe("blackboard");

			const cycles = await bb.events.query({
				type: "runtime_cycle",
				source: "runtime",
				limit: 2,
			});
			expect(cycles.map((e) => (e.payload as { n: number }).n)).toEqual([2, 3]);
		} finally {
			await cleanup();
		}
	});

	test("torn or malformed lines are skipped, not fatal", async () => {
		const { bb, workbenchRoot, cleanup } = await makeTempWorkbench();
		try {
			await bb.events.append(event("runtime_cycle", 1));
			// simulate a crash mid-append: a torn JSON line (newline included,
			// as a partially flushed buffer would leave behind)
			await appendFile(
				join(workbenchRoot, "events", "events.jsonl"),
				'{"timestamp":"20\n',
				"utf8",
			);
			await bb.events.append(event("runtime_cycle", 2));

			const tail = await bb.events.tail(10);
			expect(tail.map((e) => (e.payload as { n: number }).n)).toEqual([1, 2]);
		} finally {
			await cleanup();
		}
	});

	test("assigns unique stable ids and a shared eventSeq across open instances", async () => {
		const { bb, workbenchRoot, cleanup } = await makeTempWorkbench();
		try {
			const second = openBlackboard(workbenchRoot);
			const writes = Array.from({ length: 24 }, (_, n) =>
				(n % 2 === 0 ? bb : second).events.append(event("concurrent", n)),
			);
			const appended = await Promise.all(writes);
			const ids = appended.map((item) => item.id);
			const seqs = appended
				.map((item) => item.eventSeq)
				.sort((a, b) => (a ?? 0) - (b ?? 0));
			expect(new Set(ids).size).toBe(24);
			expect(seqs).toEqual(Array.from({ length: 24 }, (_, n) => n + 1));
			const persisted = await bb.events.all();
			expect(persisted).toHaveLength(24);
			expect(new Set(persisted.map((item) => item.id)).size).toBe(24);
		} finally {
			await cleanup();
		}
	});

	test("keeps legacy rows readable and rebuilds the cursor after an external append", async () => {
		const { bb, workbenchRoot, cleanup } = await makeTempWorkbench();
		try {
			const file = join(workbenchRoot, "events", "events.jsonl");
			await bb.events.append(event("before", 1));
			await appendFile(
				file,
				`${JSON.stringify({
					timestamp: "2026-08-28T00:00:00.000Z",
					source: "legacy",
					type: "raw_append",
					payload: { legacy: true },
				})}\n`,
				"utf8",
			);
			const after = await bb.events.append(event("after", 2));
			expect(after.eventSeq).toBe(3);
			const rows = await bb.events.all();
			expect(rows.map((row) => row.eventSeq)).toEqual([1, 2, 3]);
			expect(rows[1]?.id).toBe("legacy-2");
			// A hand-written old log with no id/eventSeq remains a valid read view.
			await writeFile(
				file,
				`${JSON.stringify({
					timestamp: "2026-08-28T00:00:00.000Z",
					source: "legacy",
					type: "old_only",
					payload: null,
				})}\n`,
				"utf8",
			);
			const legacy = await bb.events.all();
			expect(legacy[0]?.id).toBe("legacy-1");
			expect(legacy[0]?.eventSeq).toBe(1);
		} finally {
			await cleanup();
		}
	});

	test("rejects lifecycle payloads that smuggle state-machine verdicts", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await expect(
				bb.events.appendThread("thread.restored", {
					threadId: "thread-1",
					status: "done",
				}),
			).rejects.toThrow("status");
			await expect(
				bb.events.appendThread("thread.restored", {
					threadId: "thread-1",
					facts: [{ nested: { verdict: "pass" } }],
				}),
			).rejects.toThrow("verdict");
		} finally {
			await cleanup();
		}
	});

	test("appendMany allocates a contiguous range under one lock", async () => {
		const { projectDir, bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.events.append(event("runtime_cycle", 0));
			const batch = await bb.events.appendMany([
				event("footprint", 1),
				event("interaction", 2),
				event("interaction", 3),
			]);
			expect(batch.map((e) => e.eventSeq)).toEqual([2, 3, 4]);
			expect(new Set(batch.map((e) => e.id)).size).toBe(3);
			// the cursor is written once per batch, so a reopened instance must
			// still continue from the last line instead of reusing a stale seq
			const reopened = openBlackboard(join(projectDir, ".workbench"));
			const next = await reopened.events.append(event("runtime_cycle", 4));
			expect(next.eventSeq).toBe(5);
			expect((await bb.events.all()).map((e) => e.eventSeq)).toEqual([
				1, 2, 3, 4, 5,
			]);
			expect(await bb.events.appendMany([])).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	test("a rejected batch member leaves no partial write", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await expect(
				bb.events.appendMany([
					event("runtime_cycle", 0),
					{
						timestamp: new Date().toISOString(),
						source: "threads",
						type: "thread.restored",
						payload: { threadId: "thread-1", verdict: "pass" },
					},
				]),
			).rejects.toThrow("verdict");
			expect(await bb.events.all()).toEqual([]);
		} finally {
			await cleanup();
		}
	});
});
