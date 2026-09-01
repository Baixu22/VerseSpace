import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractFootprint, hashPathClaim } from "../blackboard/footprint";
import { makeTempWorkbench } from "../test/fixtures";
import { parseHunks, reconcilePremises } from "./premises";

/** A big file the writer only ever reads a slice of. */
function bigFile(mutate?: (lines: string[]) => void): string {
	const lines: string[] = [];
	for (let i = 1; i <= 2000; i += 1) {
		lines.push(`export const v${i} = ${i};`);
	}
	mutate?.(lines);
	return `${lines.join("\n")}\n`;
}

describe("parseHunks（-U0 精确区间）", () => {
	test("改动、插入、删除三种 hunk 都能解析", () => {
		expect(parseHunks("@@ -10,3 +10,4 @@")).toEqual([
			{ oldStart: 10, oldCount: 3, newCount: 4 },
		]);
		// 纯插入：旧区间为空，形如 @@ -0,0 +1,5 @@
		expect(parseHunks("@@ -0,0 +1,5 @@")).toEqual([
			{ oldStart: 0, oldCount: 0, newCount: 5 },
		]);
		// 纯删除：@@ -7,2 +6,0 @@（省略的计数默认为 1，但 git 总会写出来）
		expect(parseHunks("@@ -7,2 +6,0 @@")).toEqual([
			{ oldStart: 7, oldCount: 2, newCount: 0 },
		]);
		expect(parseHunks("no hunks here")).toEqual([]);
	});
});

describe("跨度限定的读（R2 谓词第 2 层 · TF-0075）", () => {
	test("Read 带 offset/limit 时记录区间，整文件读不记录", () => {
		const partial = extractFootprint(
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "Read",
							input: { file_path: "src/a.ts", offset: 100, limit: 20 },
						},
					],
				},
			},
			"w",
		);
		expect(partial?.used[0]?.span).toEqual({ start: 100, end: 119 });

		const whole = extractFootprint(
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "t2",
							name: "Read",
							input: { file_path: "src/a.ts" },
						},
					],
				},
			},
			"w",
		);
		expect(whole?.used[0]?.span).toBeUndefined();
	});

	test("区间哈希只覆盖读过的那几行", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "big.ts"), bigFile(), "utf8");
			const claim = await hashPathClaim(
				ws.projectDir,
				"src/big.ts",
				undefined,
				{ start: 100, end: 120 },
			);
			expect(claim.span?.hash).toBeTruthy();
			// 同一个区间，两次算出来必须一样
			const again = await hashPathClaim(
				ws.projectDir,
				"src/big.ts",
				undefined,
				{ start: 100, end: 120 },
			);
			expect(again.span?.hash).toBe(claim.span?.hash);
			// 错开一行就不一样
			const shifted = await hashPathClaim(
				ws.projectDir,
				"src/big.ts",
				undefined,
				{ start: 101, end: 121 },
			);
			expect(shifted.span?.hash).not.toBe(claim.span?.hash);
		} finally {
			await ws.cleanup();
		}
	});

	// ---- 验收标准 ----

	test("读了 2000 行文件的第 100–120 行，别人改第 3 行时静默", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "big.ts"), bigFile(), "utf8");
			const spoolDir = join(ws.workbenchRoot, "sessions", "w", "spool");
			const claim = await hashPathClaim(ws.projectDir, "src/big.ts", spoolDir, {
				start: 100,
				end: 120,
			});
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [claim],
				generated: [],
			});

			// 写者 A 改的是第 3 行，不在读过区间里
			await writeFile(
				join(ws.projectDir, "src", "big.ts"),
				bigFile((lines) => {
					lines[2] = "export const v3 = 9999;";
				}),
				"utf8",
			);

			const notices = await reconcilePremises(ws.bb);
			expect(notices).toHaveLength(0);
			expect(await ws.bb.events.query({ type: "premise_stale" })).toHaveLength(
				0,
			);
		} finally {
			await ws.cleanup();
		}
	});

	test("改动落在读过的区间里时照常通知", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "big.ts"), bigFile(), "utf8");
			const spoolDir = join(ws.workbenchRoot, "sessions", "w", "spool");
			const claim = await hashPathClaim(ws.projectDir, "src/big.ts", spoolDir, {
				start: 100,
				end: 120,
			});
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [claim],
				generated: [],
			});

			// 第 110 行：正在读过的区间内
			await writeFile(
				join(ws.projectDir, "src", "big.ts"),
				bigFile((lines) => {
					lines[109] = "export const v110 = 9999;";
				}),
				"utf8",
			);

			const notices = await reconcilePremises(ws.bb);
			expect(notices).toHaveLength(1);
			expect(notices[0]!.stale.map((s) => s.path)).toEqual(["src/big.ts"]);
		} finally {
			await ws.cleanup();
		}
	});

	test("区间上方插入行：内容没变，重定位后静默", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "big.ts"), bigFile(), "utf8");
			const spoolDir = join(ws.workbenchRoot, "sessions", "w", "spool");
			const claim = await hashPathClaim(ws.projectDir, "src/big.ts", spoolDir, {
				start: 100,
				end: 120,
			});
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [claim],
				generated: [],
			});

			// 文件开头插 5 行：区间整体下移，但内容一字未改
			await writeFile(
				join(ws.projectDir, "src", "big.ts"),
				bigFile((lines) => {
					lines.unshift(
						"// inserted",
						"// inserted",
						"// inserted",
						"// x",
						"// y",
					);
				}),
				"utf8",
			);

			const notices = await reconcilePremises(ws.bb);
			expect(notices).toHaveLength(0);
		} finally {
			await ws.cleanup();
		}
	});

	test("没有读时快照时退回第 1 层（宁可多通知，不静默）", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "big.ts"), bigFile(), "utf8");
			// 不传 spoolDir → 没有快照 → 无法算 hunk
			const claim = await hashPathClaim(
				ws.projectDir,
				"src/big.ts",
				undefined,
				{
					start: 100,
					end: 120,
				},
			);
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [claim],
				generated: [],
			});
			await writeFile(
				join(ws.projectDir, "src", "big.ts"),
				bigFile((lines) => {
					lines[2] = "export const v3 = 9999;";
				}),
				"utf8",
			);

			const notices = await reconcilePremises(ws.bb);
			expect(notices).toHaveLength(1);
		} finally {
			await ws.cleanup();
		}
	});
});
