import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlackboardDataError } from "../errors";
import { makeTempWorkbench } from "../test/fixtures";

describe("goals blackboard API", () => {
	test("add fills schema defaults and persists", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const goal = await bb.goals.add({ title: "实现数据层" });
			expect(goal.id).toStartWith("g-");
			expect(goal.status).toBe("planned");
			expect(goal.acceptance).toEqual([]);
			expect(goal.dependsOn).toEqual([]);
			expect(goal.verifiedAgainst).toEqual({ interfaces: {}, decisions: [] });

			const loaded = await bb.goals.get(goal.id);
			expect(loaded).toEqual(goal);
		} finally {
			await cleanup();
		}
	});

	test("list returns every goal sorted by id", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const a = await bb.goals.add({ title: "A" });
			const b = await bb.goals.add({ title: "B" });
			const listed = await bb.goals.list();
			expect(listed.map((goal) => goal.id)).toEqual([a.id, b.id].sort());
		} finally {
			await cleanup();
		}
	});

	test("get returns null for missing goal", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			expect(await bb.goals.get("g-nope")).toBeNull();
		} finally {
			await cleanup();
		}
	});

	test("update merges a patch without touching the id", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const goal = await bb.goals.add({ title: "A" });
			const updated = await bb.goals.update(goal.id, {
				status: "ready",
				dependsOn: ["g-other"],
			});
			expect(updated.status).toBe("ready");
			expect(updated.title).toBe("A");
			expect(updated.id).toBe(goal.id);
			expect((await bb.goals.list()).map((g) => g.status)).toEqual(["ready"]);
		} finally {
			await cleanup();
		}
	});

	test("update throws for a missing goal", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			expect(
				bb.goals.update("g-nope", { status: "ready" }),
			).rejects.toBeInstanceOf(BlackboardDataError);
		} finally {
			await cleanup();
		}
	});

	test("corrupted goal file reports the offending path", async () => {
		const { bb, projectDir, cleanup } = await makeTempWorkbench();
		try {
			const bad = join(
				projectDir,
				".workbench",
				"blackboard",
				"goals",
				"g-bad.yaml",
			);
			await writeFile(bad, "id: g-bad\nstatus: not-a-status\n", "utf8");
			try {
				await bb.goals.list();
				expect.unreachable();
			} catch (error) {
				expect(error).toBeInstanceOf(BlackboardDataError);
				expect((error as BlackboardDataError).path).toBe(bad);
			}
		} finally {
			await cleanup();
		}
	});
});
