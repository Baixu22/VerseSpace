import { expect, test } from "bun:test";
import { buildRows } from "../../scripts/fit-ledger/ledger";
import { collectChatStats } from "../chat/stats";
import { ChatThreads } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import { reviewLandmark } from "./review";

test("L1 分母包含未复核地标，重复认可及另一写者的同名条目不污染判断", async () => {
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
		for (let repeat = 0; repeat < 3; repeat += 1)
			await reviewLandmark(ws.bb, a.id, "a.ts", "endorse");
		await reviewLandmark(ws.bb, b.id, "a.ts", "reject");
		const stats = await collectChatStats(ws.bb);
		expect(stats.landmarkReviews.endorsed).toBe(3);
		const current = stats.landmarkReviews.current;
		expect(current.byWriter.find((row) => row.writer === a.id)).toMatchObject({
			// The five files plus the projected project root all belong to the set.
			total: 6,
			reviewed: 1,
			endorsed: 1,
			rejected: 0,
			endorsedShare: 1 / 6,
		});
		expect(current.byWriter.find((row) => row.writer === b.id)).toMatchObject({
			total: 3,
			reviewed: 1,
			endorsed: 0,
			rejected: 1,
		});
		expect(current.total).toBe(9);
		expect(current.endorsedShare).toBe(1 / 9);
		expect(current.reviewedCoverage).toBe(2 / 9);
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
		expect(row.value).toBe(1 / 9);
		expect(row.samples).toBe(2);
		expect(row.fit).toBe("weak");
		// The same reviews under a scripted or model-run source measure the
		// script, not a user: value stays visible, fit does not move.
		for (const kind of ["unknown", "scripted", "live-model"] as const) {
			const gated = buildRows(scope, ctx, kind)[0]!;
			expect(gated.value).toBe(1 / 9);
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

test("没有当前集合的复核时保持 unknown，不借历史点赞通过验收", async () => {
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
		const stats = await collectChatStats(ws.bb);
		expect(stats.landmarkReviews.current).toMatchObject({
			total: 2,
			reviewed: 0,
			endorsed: 0,
			endorsedShare: 0,
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
