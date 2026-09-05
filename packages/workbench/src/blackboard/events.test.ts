import { describe, expect, test } from "bun:test";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

	test("跨进程并发追加：子进程与父进程共享连续无重复的 eventSeq 与 id（TF-0123）", async () => {
		const { bb, workbenchRoot, cleanup } = await makeTempWorkbench();
		try {
			// 子进程脚本：打开同一个 blackboard，顺序追加 count 条后退出。
			// 以绝对 file URL 导入包内模块，脚本本身放在 workbenchRoot 里随测试清理。
			const childScript = join(workbenchRoot, "cross-append-child.js");
			const entryUrl = pathToFileURL(join(import.meta.dir, "index.ts")).href;
			const script = [
				`const { openBlackboard } = await import(${JSON.stringify(entryUrl)});`,
				"const bb = openBlackboard(process.argv[2]);",
				"const count = Number(process.argv[3]);",
				"const child = process.argv[4];",
				"const step = async (i) => bb.events.append({",
				"  timestamp: new Date().toISOString(),",
				'  source: "cross-process",',
				'  type: "child_append",',
				"  payload: { child, n: i },",
				"});",
				"for (let i = 0; i < count; i++) {",
				"  await step(i);",
				"}",
				"process.exit(0);",
			].join("\n");
			await writeFile(childScript, script, "utf8");

			const CHILDREN = 3;
			const PER_CHILD = 8;
			const procs = Array.from({ length: CHILDREN }, (_, c) =>
				Bun.spawn(
					[
						process.execPath,
						childScript,
						workbenchRoot,
						String(PER_CHILD),
						String(c),
					],
					{ stdout: "pipe", stderr: "pipe" },
				),
			);
			// 父进程与子进程同时追加，锁竞争发生在真正的进程边界上
			const parentAppended = await Promise.all(
				Array.from({ length: 10 }, (_, n) =>
					bb.events.append(event("parent_append", n)),
				),
			);
			const exitCodes = await Promise.all(procs.map((p) => p.exited));
			const stderrs = await Promise.all(
				procs.map((p) => new Response(p.stderr).text()),
			);
			expect(stderrs.join("")).toBe("");
			expect(exitCodes).toEqual([0, 0, 0]);

			const expected = 10 + CHILDREN * PER_CHILD;
			expect(parentAppended).toHaveLength(10);
			const all = await bb.events.all();
			expect(all).toHaveLength(expected);
			// 无重复 id、无重复 eventSeq，且 1..N 连续（跨进程无缝隙）
			expect(new Set(all.map((e) => e.id)).size).toBe(expected);
			const seqs = all.map((e) => e.eventSeq as number).sort((a, b) => a - b);
			expect(seqs).toEqual(Array.from({ length: expected }, (_, n) => n + 1));

			// 子进程全部退出后，父进程游标从外部追加继续单调分配
			const after = await bb.events.append(event("parent_append", 99));
			expect(after.eventSeq).toBe(expected + 1);
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

	test("thread.merged_back joins the whitelist; unknown thread types still throw", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.events.append({
				timestamp: new Date().toISOString(),
				source: "threads",
				type: "thread.merged_back",
				payload: {
					threadId: "thread-parent",
					from: "thread-child",
					into: "thread-parent",
					level: "summary",
					facts: { ledgerDiffRefs: ["e-1"] },
				},
			});
			expect((await bb.events.all()).map((e) => e.type)).toEqual([
				"thread.merged_back",
			]);

			await expect(
				bb.events.append({
					timestamp: new Date().toISOString(),
					source: "threads",
					type: "thread.merged_back_v2",
					payload: { threadId: "t" },
				}),
			).rejects.toThrow("未知线程生命周期事件");
		} finally {
			await cleanup();
		}
	});
});
