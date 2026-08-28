import { describe, expect, test } from "bun:test";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";

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
});
