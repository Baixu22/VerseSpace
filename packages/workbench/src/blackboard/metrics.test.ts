import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyUsage } from "../agents/usage";
import { BlackboardDataError } from "../errors";
import { makeTempWorkbench } from "../test/fixtures";

/**
 * A lane's counters are the ONLY record of what was observed, and `record()`
 * folds a sample onto the stored value and writes the result back. So a read
 * that fails must not be laundered into `emptyLaneMetrics`: that zeroed value
 * would then be persisted, destroying the lane's accumulated totals while
 * reporting success — the failure would read as a healthy lane.
 */

describe("lane metric durability (TF-0084)", () => {
	test("a corrupt lane file is surfaced, never laundered into a zeroed overwrite", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.metrics.record("ws-a", { ...emptyUsage(), outputTokens: 42 });
			const file = join(bb.paths.metrics, "ws-a.yaml");
			await writeFile(file, "outputTokens: [unclosed\n", "utf8");
			const corrupt = await readFile(file, "utf8");

			// the read failure is visible, and names the file it could not read
			try {
				await bb.metrics.get("ws-a");
				expect.unreachable();
			} catch (error) {
				expect(error).toBeInstanceOf(BlackboardDataError);
				expect((error as BlackboardDataError).path).toBe(file);
			}

			// `record` refuses to fold onto a fake zero, so the accumulated
			// totals on disk survive the failed sample
			await expect(
				bb.metrics.record("ws-a", { ...emptyUsage(), outputTokens: 1 }),
			).rejects.toBeInstanceOf(BlackboardDataError);
			expect(await readFile(file, "utf8")).toBe(corrupt);
		} finally {
			await cleanup();
		}
	});

	test("a lane that was never observed still reads as zeroes", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const lane = await bb.metrics.get("ws-fresh");
			expect(lane.workspot).toBe("ws-fresh");
			expect(lane.outputTokens).toBe(0);
			expect(lane.turns).toBe(0);
		} finally {
			await cleanup();
		}
	});
});
