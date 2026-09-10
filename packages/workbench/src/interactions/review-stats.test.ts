import { expect, test } from "bun:test";
import { buildRows } from "../../scripts/fit-ledger/ledger";
import type { Blackboard } from "../blackboard";
import { collectChatStats } from "../chat/stats";
import { ChatThreads } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import { collectInterest } from "./context";
import { contentTypeOf } from "./derive";
import { reviewLandmark } from "./review";
import { INTERACTIONS_SOURCE, INTERACTIONS_TYPE } from "./types";

/**
 * 造真地标：DOI = Σweight − 衰减，edit 权重 2、地标阈值 10，所以同一个文件
 * 要在衰减窗口内被编辑 6 次才越过地标线。这串数字本身就是 2026-09-11 的发现：
 * 真实工作形状是每个文件 1–2 次编辑，于是「地标集合」几乎总是空集。
 *
 * contentType 走真实派生（`contentTypeOf`），不要手写：夹具把 `src` 标成 file
 * 的话，测的就不是「目录不进 L1 分母」这件事了。
 */
async function appendEdits(
	bb: Blackboard,
	origin: string,
	handle: string,
	times: number,
): Promise<void> {
	for (let index = 0; index < times; index += 1) {
		const time = new Date().toISOString();
		await bb.events.append({
			timestamp: time,
			source: INTERACTIONS_SOURCE,
			type: INTERACTIONS_TYPE,
			payload: {
				time,
				kind: "edit",
				origin,
				contentType: contentTypeOf(handle),
				handle,
				delta: 1,
			},
		});
	}
}

test("L1 分母是地标集合（DOI>10），不是回退显示表；重复认可与同名条目不串台", async () => {
	const ws = await makeTempWorkbench();
	try {
		const chat = new ChatThreads(ws.bb);
		const a = await chat.create("A");
		const b = await chat.create("B");
		for (const [writer, paths] of [
			[a.id, ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]],
			[b.id, ["a.ts", "z.ts"]],
		] as const) {
			await ws.bb.sessions.recordActivity(writer, {
				activity: "work",
				agent: writer,
				used: [],
				generated: paths.map((path) => ({ path })),
			});
		}
		// 只把 a.ts 推到地标线以上：b.ts..e.ts / z.ts 留在可见但非地标。
		await appendEdits(ws.bb, a.id, "a.ts", 6);
		await appendEdits(ws.bb, b.id, "a.ts", 6);
		// 目录也能被推到地标线以上（它同样进 DOI 集合、也能被复核），但 L1 的
		// 分母只收文件级：人没法把 `src` 回答成「这次干的活的核心」。
		await appendEdits(ws.bb, a.id, "src", 10);
		for (let repeat = 0; repeat < 3; repeat += 1)
			await reviewLandmark(ws.bb, a.id, "a.ts", "endorse");
		await reviewLandmark(ws.bb, b.id, "a.ts", "reject");
		const stats = await collectChatStats(ws.bb);
		expect(stats.landmarkReviews.endorsed).toBe(3);
		const current = stats.landmarkReviews.current;
		const writerA = current.byWriter.find((row) => row.writer === a.id)!;
		const writerB = current.byWriter.find((row) => row.writer === b.id)!;
		// 分母来自 DOI>10 的 handle：被编辑 6 次的 a.ts 进集合，只被触碰一次的
		// b.ts..e.ts / z.ts 不进——「被显示过」不等于「是地标」。
		const interestA = await collectInterest(ws.bb, a.id);
		const interestB = await collectInterest(ws.bb, b.id);
		const handlesA = interestA.landmarkHandles;
		const handlesB = interestB.landmarkHandles;
		expect(handlesA).toContain("a.ts");
		expect(handlesA).not.toContain("b.ts");
		expect(handlesB).toContain("a.ts");
		expect(handlesB).not.toContain("z.ts");
		// 目录进了 DOI 地标集合，但不进 L1 的分母。
		expect(handlesA).toContain("src");
		expect(interestA.fileLandmarkHandles).not.toContain("src");
		expect(interestA.fileLandmarkHandles).toContain("a.ts");
		expect(writerA.total).toBe(interestA.fileLandmarkHandles.length);
		expect(writerA.total).toBeLessThan(handlesA.length);
		expect(writerA).toMatchObject({
			reviewed: 1,
			endorsed: 1,
			rejected: 0,
			endorsedShare: 1 / writerA.total,
		});
		expect(writerB).toMatchObject({
			reviewed: 1,
			endorsed: 0,
			rejected: 1,
			endorsedShare: 0,
		});
		expect(current.total).toBe(writerA.total + writerB.total);
		expect(current.endorsedShare).toBe(1 / current.total);
		expect(current.reviewedCoverage).toBe(2 / current.total);
		const ctx = {
			stats,
			events: await ws.bb.events.all(),
			writerKind: new Map<string, "agent">([
				[a.id, "agent"],
				[b.id, "agent"],
			]),
		};
		const scope = [
			{ id: "TF-0154", title: "地标认可", kind: "task", status: "done" },
		];
		const row = buildRows(scope, ctx, "natural")[0]!;
		expect(row.value).toBe(1 / current.total);
		expect(row.samples).toBe(2);
		// 两个写者各一个文件级地标，认可 1 / 共 2 = 0.5，正好压在 partial 边界
		// （≥0.8 aligned / ≥0.5 partial / 否则 weak）。
		expect(row.fit).toBe("partial");
		// The same reviews under a scripted or model-run source measure the
		// script, not a user: value stays visible, fit does not move.
		for (const kind of ["unknown", "scripted", "live-model"] as const) {
			const gated = buildRows(scope, ctx, kind)[0]!;
			expect(gated.value).toBe(1 / current.total);
			expect(gated.samples).toBe(2);
			expect(gated.fit).toBe("unknown");
			expect(gated.why).toContain("不构成用户认可");
		}
		await reviewLandmark(ws.bb, a.id, "a.ts", "reject");
		expect(
			(await collectChatStats(ws.bb)).landmarkReviews.current.endorsed,
		).toBe(0);
	} finally {
		await ws.cleanup();
	}
});

test("没有地标就没有 L1 样本：回退显示表不是地标集合，历史点赞也不救场", async () => {
	const ws = await makeTempWorkbench();
	try {
		const chat = new ChatThreads(ws.bb);
		const thread = await chat.create();
		await ws.bb.sessions.recordActivity(thread.id, {
			activity: "work",
			agent: thread.id,
			used: [],
			generated: [{ path: "a.ts" }],
		});
		await ws.bb.events.append({
			timestamp: new Date().toISOString(),
			source: "human",
			type: "landmark.reviewed",
			payload: { writer: thread.id, handle: "old.ts", verdict: "endorse" },
		});
		// 投影仍非空（列表永不为空），但那是回退可见表，不是地标集合。
		expect(
			(await collectInterest(ws.bb, thread.id)).landmarks.length,
		).toBeGreaterThan(0);
		expect(
			(await collectInterest(ws.bb, thread.id)).landmarkHandles,
		).toHaveLength(0);
		const stats = await collectChatStats(ws.bb);
		expect(stats.landmarkReviews.current).toMatchObject({
			total: 0,
			reviewed: 0,
			endorsed: 0,
			endorsedShare: null,
		});
		const row = buildRows(
			[{ id: "TF-0154", title: "地标认可", kind: "task", status: "done" }],
			{
				stats,
				events: await ws.bb.events.all(),
				writerKind: new Map([[thread.id, "agent"]]),
			},
			"natural",
		)[0]!;
		expect(row.fit).toBe("unknown");
		expect(row.samples).toBe(0);
	} finally {
		await ws.cleanup();
	}
});
