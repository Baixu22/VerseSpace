import { expect, test } from "bun:test";
import { buildRows } from "../../scripts/fit-ledger/ledger";
import type { Blackboard } from "../blackboard";
import { collectChatStats } from "../chat/stats";
import { ChatThreads } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import {
	collectInterest,
	interestFromEvents,
	sessionFileTopK,
} from "./context";
import { contentTypeOf } from "./derive";
import { reviewLandmark } from "./review";
import {
	currentLandmarkAcceptance,
	relativeLandmarkCoverage,
} from "./review-stats";
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

/**
 * 写者投影：L1 的种类门按 `kind` 判定。线程夹具一律是 agent——门要清的正是
 * git 监视与 human 编辑器这两类「记录型」写者。
 */
const agentRef = (id: string) => ({ id, kind: "agent" });

test("TF-0057：代理自审（steward）是真实数据，但绝不能抬升「用户认可」口径", async () => {
	const ws = await makeTempWorkbench();
	try {
		const chat = new ChatThreads(ws.bb);
		const worker = await chat.create("W");
		await ws.bb.sessions.recordActivity(worker.id, {
			activity: "work",
			agent: worker.id,
			used: [],
			generated: [],
		});
		await appendEdits(ws.bb, worker.id, "a.ts", 6); // 过地标线
		const rows = () => ws.bb.events.query({});
		// 先只写自审：两条读数必须一条动、一条不动
		await reviewLandmark(
			ws.bb,
			worker.id,
			"a.ts",
			"endorse",
			"自审：需求就是改这个文件",
			{ source: "steward" },
		);
		const human = currentLandmarkAcceptance(await rows(), [
			agentRef(worker.id),
		]);
		const steward = currentLandmarkAcceptance(
			await rows(),
			[agentRef(worker.id)],
			Date.now(),
			"steward",
		);
		expect({ total: human.total, endorsed: human.endorsed }).toEqual({
			total: 1,
			endorsed: 0,
		});
		expect({ total: steward.total, endorsed: steward.endorsed }).toEqual({
			total: 1,
			endorsed: 1,
		});
		// 再补人类回答：两条各自独立累积，互不覆盖
		await reviewLandmark(
			ws.bb,
			worker.id,
			"a.ts",
			"reject",
			"我当时真正改的是别处",
		);
		const human2 = currentLandmarkAcceptance(await rows(), [
			agentRef(worker.id),
		]);
		const steward2 = currentLandmarkAcceptance(
			await rows(),
			[agentRef(worker.id)],
			Date.now(),
			"steward",
		);
		expect({ endorsed: human2.endorsed, rejected: human2.rejected }).toEqual({
			endorsed: 0,
			rejected: 1,
		});
		expect({
			endorsed: steward2.endorsed,
			rejected: steward2.rejected,
		}).toEqual({ endorsed: 1, rejected: 0 });
		// 来源不合法要立刻报错，不能悄悄落成 human
		await expect(
			reviewLandmark(ws.bb, worker.id, "a.ts", "endorse", "", {
				source: "model" as never,
			}),
		).rejects.toThrow("未知的复核来源");
	} finally {
		await ws.cleanup();
	}
});

test("TF-0156 验收三：绝对阈值空集时，相对选择的 top-K 仍然列得出来", async () => {
	const ws = await makeTempWorkbench();
	try {
		const chat = new ChatThreads(ws.bb);
		const worker = await chat.create("W");
		const idle = await chat.create("I");
		for (const writer of [worker.id, idle.id]) {
			await ws.bb.sessions.recordActivity(writer, {
				activity: "work",
				agent: writer,
				used: [],
				generated: [],
			});
		}
		// 真实工作形状：每个文件只被编辑一两次（权重 2），离地标线（10）差得远，
		// 所以绝对阈值口径下这个会话的地标集合是空的（`interestFromEvents` 已测）。
		for (const path of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
			await appendEdits(ws.bb, worker.id, path, 2);
		}
		await appendEdits(ws.bb, worker.id, "src", 3); // 目录不能进 top-K

		const rows = await ws.bb.events.query({
			source: INTERACTIONS_SOURCE,
			type: INTERACTIONS_TYPE,
		});
		expect(interestFromEvents(rows, worker.id).fileLandmarkHandles).toEqual([]);
		const top3 = sessionFileTopK(rows, worker.id, 3);
		expect(top3).toHaveLength(3);
		expect(top3).not.toContain("src"); // 目录永远不进 top-K
		// 编辑次数并列时，**最近的触碰排前**：会话时钟下衰减最小的那个 DOI 最高。
		// 这条次序是确定的（同分才回落到字典序），所以可以钉住。
		expect(top3[0]).toBe("d.ts");
		// K 可以调大，四个文件都在（目录不在）
		expect(sessionFileTopK(rows, worker.id, 10).sort()).toEqual([
			"a.ts",
			"b.ts",
			"c.ts",
			"d.ts",
		]);
		const coverage = relativeLandmarkCoverage(
			rows,
			[agentRef(worker.id), agentRef(idle.id)],
			3,
		);
		// 分母是「有文件级触碰的会话」：没碰过文件的会话不算进去，不然覆盖率会被
		// 拉高成假象
		expect(coverage).toMatchObject({
			k: 3,
			sessions: 1,
			withSet: 1,
			items: 3,
			share: 1,
			distinctHandles: 3,
		});
	} finally {
		await ws.cleanup();
	}
});

test("L1 分母是地标集合（两把尺子并报），不是回退显示表；重复认可与同名条目不串台", async () => {
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

		// 旧口径（阈值 DOI>10）的契约照旧成立，双读数期它逐条报出：口径切换会让
		// 认可率跳，但跳的是分母，不是人的回答——所以旧读数必须同时可见。
		const threshold = stats.landmarkReviews.threshold;
		expect(threshold.denominator).toBe("threshold");
		const thresholdA = threshold.byWriter.find((row) => row.writer === a.id)!;
		const thresholdB = threshold.byWriter.find((row) => row.writer === b.id)!;
		expect(thresholdA.total).toBe(interestA.fileLandmarkHandles.length);
		expect(thresholdA.total).toBeLessThan(handlesA.length);
		expect(thresholdA).toMatchObject({
			reviewed: 1,
			endorsed: 1,
			rejected: 0,
			endorsedShare: 1,
		});
		expect(thresholdB).toMatchObject({
			reviewed: 1,
			endorsed: 0,
			rejected: 1,
			endorsedShare: 0,
		});
		expect(threshold.total).toBe(thresholdA.total + thresholdB.total);
		expect(threshold.endorsedShare).toBe(1 / threshold.total);

		// 新口径（TF-0159：每会话文件级 top-3）：同一个现场，分母从 2 条涨到 5 条
		// （A 的 a.ts + b.ts/c.ts、B 的 a.ts + z.ts）。认可仍是那 1 条，所以认可率
		// 会掉——这一跳是尺子造成的，账本并报两条就是为了让人看得出这件事。
		const current = stats.landmarkReviews.current;
		expect(current.denominator).toBe("session-top-k");
		expect(current.topK).toBe(3);
		expect(current.gatedWriters).toBe(0);
		const currentA = current.byWriter.find((row) => row.writer === a.id)!;
		const currentB = current.byWriter.find((row) => row.writer === b.id)!;
		expect(currentA.total).toBe(3);
		expect(currentB.total).toBe(2);
		expect(current.total).toBe(5);
		expect({ endorsed: current.endorsed, reviewed: current.reviewed }).toEqual({
			endorsed: 1,
			reviewed: 2,
		});
		expect(current.endorsedShare).toBe(1 / 5);
		expect(current.reviewedCoverage).toBe(2 / 5);
		// 三条结论都落在新集合里：没有 legacy，没有数据丢失。
		expect(current.legacyReviews).toBe(0);
		// 相对口径的覆盖：两个写者都有文件级触碰，都排得出非空 top-K。
		expect(stats.landmarkReviews.coverage).toMatchObject({
			k: 3,
			sessions: 2,
			withSet: 2,
			items: 5,
			distinctHandles: 4,
			gatedWriters: 0,
		});
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
		// 账本行读的是**新口径**：判据要能被「人回答门后 top-3」填上，就必须跟分母
		// 一起换。留在阈值口径上，门后分母为 0 的现场会永远 unknown——人答了也不动。
		expect(row.value).toBe(current.endorsedShare);
		expect(row.samples).toBe(current.reviewed);
		expect(row.fit).toBe("weak");
		// The same reviews under a scripted or model-run source measure the
		// script, not a user: value stays visible, fit does not move.
		for (const kind of ["unknown", "scripted", "live-model"] as const) {
			const gated = buildRows(scope, ctx, kind)[0]!;
			expect(gated.value).toBe(current.endorsedShare);
			expect(gated.samples).toBe(current.reviewed);
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

test("回退显示表不是候选集合：阈值口径空集仍不可计算，新口径只收真触碰过的文件", async () => {
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
		// 投影仍非空（列表永不为空），但那是回退可见表，不是候选集合。
		expect(
			(await collectInterest(ws.bb, thread.id)).landmarks.length,
		).toBeGreaterThan(0);
		expect(
			(await collectInterest(ws.bb, thread.id)).landmarkHandles,
		).toHaveLength(0);
		const stats = await collectChatStats(ws.bb);
		// 旧口径：一次触碰离地标线（10 分）差得远，分母为 0 → 判据不可计算，不是 0 分。
		expect(stats.landmarkReviews.threshold).toMatchObject({
			denominator: "threshold",
			total: 0,
			reviewed: 0,
			endorsed: 0,
			endorsedShare: null,
		});
		// 新口径：a.ts 真的被碰过一次，于是进 top-K——这是「尺子换了」而不是
		// 「历史点赞被凑进分母」。历史那条 old.ts 的结论落在集合外，只记 legacy，
		// 不删也不改判（它对旧口径成立，对新口径不成立，两件事都要留着）。
		expect(stats.landmarkReviews.current).toMatchObject({
			denominator: "session-top-k",
			total: 1,
			reviewed: 0,
			endorsed: 0,
			reviewedCoverage: 0,
			legacyReviews: 1,
			gatedWriters: 0,
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
		// 候选非空但一条都没被复核 → 仍然没有样本，fit 停在 unknown。
		expect(row.fit).toBe("unknown");
		expect(row.samples).toBe(0);
	} finally {
		await ws.cleanup();
	}
});
