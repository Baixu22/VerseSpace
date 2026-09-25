import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { openBlackboard } from "../blackboard";
import { makeTempWorkbench } from "../test/fixtures";
import type { Workspot } from "../types/workspot";

function sampleWorkspot(id: string): Workspot {
	return {
		id,
		branch: `ws/${id}`,
		worktreePath: `../${id}-worktree`,
		primaryTask: "g-1",
		binding: "primary",
		status: "idle",
		contextNeeds: { decisions: [], interfaces: [] },
	};
}

describe("state blackboard API", () => {
	test("workspot save / get / list", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.state.workspots.save(sampleWorkspot("ws-a"));
			const loaded = await bb.state.workspots.get("ws-a");
			expect(loaded).toEqual(sampleWorkspot("ws-a"));

			await bb.state.workspots.save(sampleWorkspot("ws-b"));
			expect((await bb.state.workspots.list()).map((ws) => ws.id)).toEqual([
				"ws-a",
				"ws-b",
			]);
			expect(await bb.state.workspots.get("missing")).toBeNull();
		} finally {
			await cleanup();
		}
	});

	test("queue enqueue is idempotent, dequeue removes", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.state.queue.enqueue("g-1");
			await bb.state.queue.enqueue("g-2");
			await bb.state.queue.enqueue("g-1");
			expect(await bb.state.queue.get()).toEqual(["g-1", "g-2"]);

			expect(await bb.state.queue.dequeue("g-1")).toEqual(["g-2"]);
			expect(await bb.state.queue.dequeue("g-404")).toEqual(["g-2"]);
		} finally {
			await cleanup();
		}
	});

	// TF-0269 (OPEN-6)：读不出来的条目以前让队列无声少一项——那个目标从此不会被
	// 派发，而 enqueue 的 seq 是拿这份列表的长度算的。
	test("[TF-0269] queue: an unreadable entry is omitted AND named, not silently dropped", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		const originalError = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => {
			errors.push(args.map((a) => String(a)).join(" "));
		};
		try {
			await bb.state.queue.enqueue("g-1");
			await writeFile(
				join(bb.paths.queue, "g-broken.yaml"),
				"goalId: [unclosed\n",
				"utf8",
			);
			// 省略仍然发生（降级可以），但必须看得见（静默不行）
			expect(await bb.state.queue.get()).toEqual(["g-1"]);
			expect(errors.join("\n")).toContain("g-broken.yaml");
		} finally {
			console.error = originalError;
			await cleanup();
		}
	});

	test("20 concurrent enqueues all survive (one file per entry)", async () => {
		const { projectDir, cleanup } = await makeTempWorkbench();
		try {
			// independent handles: the old single queue.yaml lost concurrent
			// appends through read-modify-write races
			const bbs = Array.from({ length: 20 }, () =>
				openBlackboard(join(projectDir, ".workbench")),
			);
			await Promise.all(
				bbs.map((bb, i) => bb.state.queue.enqueue(`g-noise-${i}`)),
			);
			const final = openBlackboard(join(projectDir, ".workbench"));
			expect(await final.state.queue.get()).toHaveLength(20);
		} finally {
			await cleanup();
		}
	});

	test("conflicts append in order", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.state.conflicts.add(
				"workspot_status",
				"ws-a active but goal g-1 cancelled",
			);
			await bb.state.conflicts.add("interface_drift", "core/api drifted");
			const listed = await bb.state.conflicts.list();
			expect(listed).toHaveLength(2);
			expect(listed[0]?.kind).toBe("workspot_status");
			expect(listed[1]?.kind).toBe("interface_drift");
		} finally {
			await cleanup();
		}
	});
});
