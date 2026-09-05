import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { collectChatStats } from "../chat/stats";
import { makeTempWorkbench } from "../test/fixtures";
import {
	foldPremisePasses,
	judgeNotifyRatio,
	PREMISE_PASS_EVENT,
	type PremisePassCounts,
} from "./premise-counts";
import { reconcilePremises } from "./premises";

/**
 * TF-0149：三层谓词逐层计数。这些用例钉住的是「比值可读」这一件事——
 * 每个 pass 的候选死在哪一层必须有数，且账要平。
 */

type Workbench = Awaited<ReturnType<typeof makeTempWorkbench>>;

/** A big file so a span read is a genuinely small slice of it. */
function bigFile(mutate?: (lines: string[]) => void): string {
	const lines: string[] = [];
	for (let i = 1; i <= 2000; i += 1) {
		lines.push(`export const v${i} = ${i};`);
	}
	mutate?.(lines);
	return `${lines.join("\n")}\n`;
}

async function passCounts(ws: Workbench): Promise<PremisePassCounts[]> {
	const events = await ws.bb.events.query({ type: PREMISE_PASS_EVENT });
	return events.map((event) => event.payload as PremisePassCounts);
}

/** The identity every recorded pass must satisfy — layer 1 stays outside it. */
function expectBalanced(counts: PremisePassCounts): void {
	expect(
		counts.suppressedL2 +
			counts.suppressedL3 +
			counts.suppressedDedup +
			counts.notified,
	).toBe(counts.overlaps);
}

async function writeSource(
	ws: Workbench,
	relative: string,
	body: string,
): Promise<void> {
	const target = join(ws.projectDir, relative);
	await mkdir(join(target, ".."), { recursive: true });
	await writeFile(target, body, "utf8");
}

describe("逐层计数（TF-0149）", () => {
	test("通知一条：overlaps 与 notified 各 1，账平", async () => {
		const ws = await makeTempWorkbench();
		try {
			await writeSource(ws, "src/a.ts", "export const a = 1;\n");
			const claim = await hashPathClaim(ws.projectDir, "src/a.ts");
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [claim],
				generated: [],
			});
			await writeSource(ws, "src/a.ts", "export const a = 2;\n");

			const notices = await reconcilePremises(ws.bb);
			expect(notices).toHaveLength(1);

			const passes = await passCounts(ws);
			expect(passes).toHaveLength(1);
			expect(passes[0]!.overlaps).toBe(1);
			expect(passes[0]!.notified).toBe(1);
			expect(passes[0]!.writers).toBe(1);
			expectBalanced(passes[0]!);
		} finally {
			await ws.cleanup();
		}
	});

	test("第 1 层：durable 读被跳过，且不进 overlaps 分母", async () => {
		const ws = await makeTempWorkbench();
		try {
			// dist/ 是 durable：内容变了也不该有人被通知
			await writeSource(ws, "dist/bundle.js", "console.log(1);\n");
			await writeSource(ws, "src/a.ts", "export const a = 1;\n");
			const durable = await hashPathClaim(ws.projectDir, "dist/bundle.js");
			const volatileClaim = await hashPathClaim(ws.projectDir, "src/a.ts");
			expect(durable.durability).toBe("durable");
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [durable, volatileClaim],
				generated: [],
			});
			// 两个文件都变了，只有 src/a.ts 该算重叠
			await writeSource(ws, "dist/bundle.js", "console.log(2);\n");
			await writeSource(ws, "src/a.ts", "export const a = 2;\n");

			await reconcilePremises(ws.bb);
			const passes = await passCounts(ws);
			expect(passes).toHaveLength(1);
			expect(passes[0]!.suppressedL1).toBe(1);
			expect(passes[0]!.overlaps).toBe(1);
			expect(passes[0]!.notified).toBe(1);
			expectBalanced(passes[0]!);
		} finally {
			await ws.cleanup();
		}
	});

	test("第 2 层：改动落在读过区间之外，overlaps 记 1 而 notified 记 0", async () => {
		const ws = await makeTempWorkbench();
		try {
			await writeSource(ws, "src/big.ts", bigFile());
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
			await writeSource(
				ws,
				"src/big.ts",
				bigFile((lines) => {
					lines[2] = "export const v3 = 9999;";
				}),
			);

			expect(await reconcilePremises(ws.bb)).toHaveLength(0);
			const passes = await passCounts(ws);
			expect(passes).toHaveLength(1);
			expect(passes[0]!.overlaps).toBe(1);
			expect(passes[0]!.suppressedL2).toBe(1);
			expect(passes[0]!.notified).toBe(0);
			expectBalanced(passes[0]!);
		} finally {
			await ws.cleanup();
		}
	});

	test("第 3 层：只读不写的依赖，导出面未变时计入 suppressedL3", async () => {
		const ws = await makeTempWorkbench();
		try {
			await writeSource(
				ws,
				"src/dep.ts",
				"export function f(a: number): number {\n\treturn a + 1;\n}\n",
			);
			const spoolDir = join(ws.workbenchRoot, "sessions", "w", "spool");
			const claim = await hashPathClaim(ws.projectDir, "src/dep.ts", spoolDir);
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [claim],
				generated: [],
			});
			// 函数体变了，签名没变：依赖读的前提仍然成立
			await writeSource(
				ws,
				"src/dep.ts",
				"export function f(a: number): number {\n\treturn a + 2;\n}\n",
			);

			expect(await reconcilePremises(ws.bb)).toHaveLength(0);
			const passes = await passCounts(ws);
			expect(passes).toHaveLength(1);
			expect(passes[0]!.overlaps).toBe(1);
			expect(passes[0]!.suppressedL3).toBe(1);
			expect(passes[0]!.notified).toBe(0);
			expectBalanced(passes[0]!);
		} finally {
			await ws.cleanup();
		}
	});

	test("去重：第二个 pass 记 suppressedDedup，不重复通知", async () => {
		const ws = await makeTempWorkbench();
		try {
			await writeSource(ws, "src/a.ts", "export const a = 1;\n");
			const claim = await hashPathClaim(ws.projectDir, "src/a.ts");
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [claim],
				generated: [],
			});
			await writeSource(ws, "src/a.ts", "export const a = 2;\n");

			expect(await reconcilePremises(ws.bb)).toHaveLength(1);
			expect(await reconcilePremises(ws.bb)).toHaveLength(0);

			const passes = await passCounts(ws);
			expect(passes).toHaveLength(2);
			expect(passes[1]!.overlaps).toBe(1);
			expect(passes[1]!.suppressedDedup).toBe(1);
			expect(passes[1]!.notified).toBe(0);
			expectBalanced(passes[1]!);
		} finally {
			await ws.cleanup();
		}
	});

	test("零重叠的 pass 不写事件：watcher 每次改动都跑，沉默必须保持沉默", async () => {
		const ws = await makeTempWorkbench();
		try {
			await writeSource(ws, "src/a.ts", "export const a = 1;\n");
			const claim = await hashPathClaim(ws.projectDir, "src/a.ts");
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [claim],
				generated: [],
			});
			// 文件一字未改
			await reconcilePremises(ws.bb);
			expect(await passCounts(ws)).toHaveLength(0);
		} finally {
			await ws.cleanup();
		}
	});
});

describe("目标区间判定（TF-0149）", () => {
	test("无样本时不报 0%，报 no-sample", () => {
		const judged = judgeNotifyRatio(0, 0);
		expect(judged.ratio).toBeNull();
		expect(judged.verdict).toBe("no-sample");
		expect(judged.advice).toContain("尚无重叠样本");
	});

	test("区间内、过多、过少三种情况都给出非空建议", () => {
		expect(judgeNotifyRatio(100, 20).verdict).toBe("in-band");
		expect(judgeNotifyRatio(100, 80).verdict).toBe("too-noisy");
		expect(judgeNotifyRatio(100, 2).verdict).toBe("too-quiet");
		// 「不静默」：越界时建议里必须写清往哪个方向调
		expect(judgeNotifyRatio(100, 80).advice).toContain("收紧谓词");
		expect(judgeNotifyRatio(100, 2).advice).toContain("放宽谓词");
		// 边界归入区间内，不算越界
		expect(judgeNotifyRatio(100, 10).verdict).toBe("in-band");
		expect(judgeNotifyRatio(100, 30).verdict).toBe("in-band");
	});

	test("坏 payload 不污染聚合：缺字段读作 0，非对象 payload 只算一个 pass", () => {
		const folded = foldPremisePasses([
			{
				timestamp: "2026-09-05T00:00:00.000Z",
				source: "runtime",
				type: PREMISE_PASS_EVENT,
				payload: { overlaps: 10, notified: 2 },
			},
			{
				timestamp: "2026-09-05T00:00:01.000Z",
				source: "runtime",
				type: PREMISE_PASS_EVENT,
				payload: "not an object",
			},
			{
				timestamp: "2026-09-05T00:00:02.000Z",
				source: "runtime",
				type: "premise_stale",
				payload: { overlaps: 999 },
			},
		]);
		expect(folded.passes).toBe(2);
		expect(folded.overlaps).toBe(10);
		expect(folded.notified).toBe(2);
		expect(folded.notifiedRatio).toBe(0.2);
		expect(folded.verdict).toBe("in-band");
		expect(folded.l3EverSuppressed).toBe(false);
	});
});

describe("stats 暴露比值（TF-0149 → TF-0136）", () => {
	test("workbench stats 的 premises 段带上比值、区间与 L3 事实", async () => {
		const ws = await makeTempWorkbench();
		try {
			await writeSource(ws, "src/a.ts", "export const a = 1;\n");
			const claim = await hashPathClaim(ws.projectDir, "src/a.ts");
			await ws.bb.sessions.register("w", "agent", "W");
			await ws.bb.sessions.recordActivity("w", {
				activity: "a1",
				agent: "w",
				used: [claim],
				generated: [],
			});
			await writeSource(ws, "src/a.ts", "export const a = 2;\n");
			await reconcilePremises(ws.bb);

			const stats = await collectChatStats(ws.bb);
			expect(stats.premises.passes).toBe(1);
			expect(stats.premises.overlaps).toBe(1);
			expect(stats.premises.notified).toBe(1);
			expect(stats.premises.notifiedRatio).toBe(1);
			expect(stats.premises.band).toEqual({ low: 0.1, high: 0.3 });
			expect(stats.premises.verdict).toBe("too-noisy");
			expect(stats.premises.advice).not.toBe("");
			expect(stats.premises.l3EverSuppressed).toBe(false);
		} finally {
			await ws.cleanup();
		}
	});

	test("一次 reconcile 都没跑过时，比值是 null 而不是 0", async () => {
		const ws = await makeTempWorkbench();
		try {
			const stats = await collectChatStats(ws.bb);
			expect(stats.premises.passes).toBe(0);
			expect(stats.premises.notifiedRatio).toBeNull();
			expect(stats.premises.verdict).toBe("no-sample");
		} finally {
			await ws.cleanup();
		}
	});
});
