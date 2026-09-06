import { describe, expect, test } from "bun:test";
import { makeTempWorkbench } from "../test/fixtures";
import {
	collectLandmarkReviews,
	foldLandmarkReviews,
	landmarkReviewJudgement,
	reviewLandmark,
} from "./review";

/**
 * TF-0154：地标认可反馈——TF-0057 的 L1 验收（地标集合 80% 用户认可）
 * 在此之前没有事件通道，只能等。手势只对当前投影里的条目有效。
 */

type Workbench = Awaited<ReturnType<typeof makeTempWorkbench>>;

/** 一个有真实读写足迹的 agent 写者：地标投影由此非空。 */
async function withActiveWriter(): Promise<Workbench> {
	const ws = await makeTempWorkbench();
	const { mkdir, writeFile } = await import("node:fs/promises");
	const { join } = await import("node:path");
	await mkdir(join(ws.projectDir, "src"), { recursive: true });
	await writeFile(
		join(ws.projectDir, "src", "a.ts"),
		"export const a = 1;\n",
		"utf8",
	);
	await writeFile(
		join(ws.projectDir, "src", "b.ts"),
		"export const b = 2;\n",
		"utf8",
	);
	await ws.bb.sessions.register("w", "agent", "W");
	await ws.bb.sessions.recordActivity("w", {
		activity: "t1",
		agent: "w",
		used: [{ path: "src/a.ts" }],
		generated: [{ path: "src/b.ts" }],
	});
	return ws;
}

describe("reviewLandmark 手势（TF-0154）", () => {
	test("对当前地标的人工人复核以 human 事件落库", async () => {
		const ws = await withActiveWriter();
		try {
			const landmarks = (await import("./context")).collectInterest;
			const list = await landmarks(ws.bb, "w");
			const top = list.landmarks[0]!.handle;
			const event = await reviewLandmark(
				ws.bb,
				"w",
				top,
				"endorse",
				"就是核心",
			);
			expect(event.id).toBeString();
			expect(event.type).toBe("landmark.reviewed");
			expect(event.source).toBe("human");
			expect(event.payload).toMatchObject({
				writer: "w",
				handle: top,
				verdict: "endorse",
				reason: "就是核心",
			});
		} finally {
			await ws.cleanup();
		}
	});

	test("不在当前地标集合中的条目拒绝复核", async () => {
		const ws = await withActiveWriter();
		try {
			await expect(
				reviewLandmark(ws.bb, "w", "src/never-touched.ts", "endorse"),
			).rejects.toThrow("不在当前地标集合中");
		} finally {
			await ws.cleanup();
		}
	});

	test("非法 verdict 直接拒绝", async () => {
		const ws = await withActiveWriter();
		try {
			await expect(
				reviewLandmark(ws.bb, "w", "src", "maybe" as "endorse"),
			).rejects.toThrow("verdict");
		} finally {
			await ws.cleanup();
		}
	});
});

describe("折叠与 L1 判定（TF-0154）", () => {
	test("fold 只认 human 来源与合法 verdict，坏 payload 跳过", () => {
		const folded = foldLandmarkReviews([
			{
				id: "e1",
				timestamp: "2026-09-06T00:00:00Z",
				source: "human",
				type: "landmark.reviewed",
				payload: { writer: "w", handle: "src/a.ts", verdict: "endorse" },
			},
			{
				id: "e2",
				timestamp: "2026-09-06T00:00:01Z",
				source: "agent",
				type: "landmark.reviewed",
				payload: { writer: "w", handle: "src/a.ts", verdict: "endorse" },
			},
			{
				id: "e3",
				timestamp: "2026-09-06T00:00:02Z",
				source: "human",
				type: "landmark.reviewed",
				payload: { writer: "w", handle: "src/b.ts", verdict: "maybe" },
			},
		] as never[]);
		expect(folded.endorsed).toBe(1);
		expect(folded.rejected).toBe(0);
		expect(folded.lastAt).toBe("2026-09-06T00:00:00Z");
	});

	test("L1 判定：分母是整个地标集合，修正取最新一次结论", () => {
		const landmarks = [
			{ handle: "a" },
			{ handle: "b" },
			{ handle: "c" },
			{ handle: "d" },
		];
		const rows = collectLandmarkReviews([
			{
				id: "e1",
				timestamp: "t1",
				source: "human",
				type: "landmark.reviewed",
				payload: { writer: "w", handle: "a", verdict: "reject" },
			},
			{
				id: "e2",
				timestamp: "t2",
				source: "human",
				type: "landmark.reviewed",
				payload: { writer: "w", handle: "a", verdict: "endorse" },
			},
			{
				id: "e3",
				timestamp: "t3",
				source: "human",
				type: "landmark.reviewed",
				payload: { writer: "w", handle: "b", verdict: "endorse" },
			},
			{
				id: "e4",
				timestamp: "t4",
				source: "human",
				type: "landmark.reviewed",
				payload: { writer: "w", handle: "ghost", verdict: "endorse" },
			},
		] as never[]);
		const judgement = landmarkReviewJudgement(landmarks, rows);
		expect(judgement.total).toBe(4);
		expect(judgement.reviewed).toBe(2);
		expect(judgement.endorsed).toBe(2);
		expect(judgement.rejected).toBe(0);
		expect(judgement.endorsedShare).toBe(0.5);
		expect(judgement.reviewedCoverage).toBe(0.5);
	});
});
