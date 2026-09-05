import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBlackboard } from "./blackboard";
import { initWorkbench } from "./commands/init";
import { findWorkbenchRoot } from "./paths";

/**
 * `findWorkbenchRoot` feeds `openBlackboard` directly, and `openBlackboard`
 * takes `<project>/.workbench` (it derives `projectRoot` from the dirname).
 * Returning the container instead made every CLI command open a phantom
 * blackboard one level up: it read none of the real data and wrote a parallel
 * tree at `<project>/events/`. No unit test caught it because every other test
 * builds its blackboard by hand; only the CLI went through this composition.
 */
describe("工作台根定位（CLI 与库的同一处交接）", () => {
	test("向上找到的是 .workbench 本身，不是它的父目录", async () => {
		const dir = await mkdtemp(join(tmpdir(), "workbench-paths-"));
		try {
			await initWorkbench(dir);
			const nested = join(dir, "src", "deep", "deeper");
			await mkdir(nested, { recursive: true });

			expect(await findWorkbenchRoot(dir)).toBe(join(dir, ".workbench"));
			expect(await findWorkbenchRoot(nested)).toBe(join(dir, ".workbench"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("接上 openBlackboard 后，事件落在 .workbench 里而不是仓库根", async () => {
		const dir = await mkdtemp(join(tmpdir(), "workbench-paths-"));
		try {
			await initWorkbench(dir);
			const root = await findWorkbenchRoot(dir);
			if (root === null) {
				throw new Error("未找到 .workbench");
			}
			const bb = openBlackboard(root);
			expect(bb.projectRoot).toBe(dir);

			await bb.events.append({
				timestamp: new Date().toISOString(),
				source: "runtime",
				type: "probe",
				payload: {},
			});
			const log = await readFile(
				join(dir, ".workbench", "events", "events.jsonl"),
				"utf8",
			);
			expect(log).toContain('"type":"probe"');
			// 影子树：仓库根下不该出现第二份事件日志
			expect(
				await readFile(join(dir, "events", "events.jsonl"), "utf8").catch(
					() => null,
				),
			).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("没有 .workbench 时返回 null，不返回一个猜出来的路径", async () => {
		const dir = await mkdtemp(join(tmpdir(), "workbench-paths-bare-"));
		try {
			// 临时目录本身可能在某个带 .workbench 的树下，因此只断言「不是本目录」
			const found = await findWorkbenchRoot(dir);
			expect(found).not.toBe(join(dir, ".workbench"));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
