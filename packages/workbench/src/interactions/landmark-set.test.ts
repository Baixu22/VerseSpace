import { describe, expect, test } from "bun:test";
import type { Blackboard } from "../blackboard";
import { ChatThreads } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import { sessionFileScores, sessionFileTopK } from "./context";
import { contentTypeOf } from "./derive";
import {
	isRecordingWriter,
	landmarkCandidates,
	RECORDING_WRITER_KINDS,
} from "./landmark-set";
import { collectLandmarkReviews, reviewLandmark } from "./review";
import {
	currentLandmarkAcceptance,
	relativeLandmarkCoverage,
} from "./review-stats";
import { INTERACTIONS_SOURCE, INTERACTIONS_TYPE } from "./types";

/**
 * TF-0161 候选 D（种类门）+ TF-0159（分母口径切换）的落库行为。
 *
 * 门的证据：2026-09-11 四现场实测，**100%** 的文件级阈值地标来自 git 监视与
 * human 编辑器，而 agent 会话 415+ 次真实触碰产出 0 条。尺子的证据：同一条事件流
 * （4 文件 11 次编辑）在阈值口径下 0 条、在相对口径下 top-3 全是真任务文件。
 *
 * 顺序纪律**先门后尺**：门只清噪声、不生产地标。反过来的话，就是拿新尺子去量
 * 同一批错东西（B 实验已踩过一次）。
 */

/** 一个会话在某个文件上的重复编辑：6 次 × edit(2) = 12 > landmarkFloor(10)。 */
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

async function register(bb: Blackboard, id: string, kind: string) {
	await bb.sessions.register(id, kind as never, id);
	await bb.sessions.recordActivity(id, {
		activity: "work",
		agent: id,
		used: [],
		generated: [],
	});
}

describe("种类门（TF-0161 候选 D）", () => {
	test("记录型种类不进候选：git/human 既不进分母，也不能被复核", async () => {
		const ws = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(ws.bb);
			const agent = await chat.create("A");
			await register(ws.bb, "git-watch", "git");
			await register(ws.bb, "editor", "human");
			// 两个记录型写者都留下「同一批文件反复落笔」的形状——live-tenant 实测形状。
			for (const handle of ["src/alpha.ts", "src/beta.ts"]) {
				await appendEdits(ws.bb, "git-watch", handle, 25);
				await appendEdits(ws.bb, "editor", handle, 25);
			}
			await appendEdits(ws.bb, agent.id, "src/task.ts", 3);

			const events = await ws.bb.events.all();
			const refs = [
				{ id: agent.id, kind: "agent" },
				{ id: "git-watch", kind: "git" },
				{ id: "editor", kind: "human" },
			];
			// 门前的阈值地标：记录型贡献全部（这两个 handle 会被推到 10 分线以上）。
			expect(
				landmarkCandidates(events, "git-watch", { denominator: "threshold" }),
			).toContain("src/alpha.ts");

			const reading = currentLandmarkAcceptance(events, refs);
			expect(reading.gatedWriters).toBe(2);
			// byWriter 里只能出现非门、且真有过交互的写者：git/human 整条不进账，
			// 而不是「进去然后算 0」——两者的区别是后者会把门的存在藏起来。
			expect(reading.byWriter.map((row) => row.writer)).toEqual([agent.id]);
			const relative = currentLandmarkAcceptance(
				events,
				refs,
				Date.now(),
				"human",
				{
					denominator: "session-top-k",
				},
			);
			const allCandidates = new Set(
				landmarkCandidates(events, agent.id, {
					denominator: "session-top-k",
				}),
			);
			expect(relative.gatedWriters).toBe(2);
			expect(relative.total).toBe(allCandidates.size);
			// 相对口径的覆盖读数同样不含记录型会话。
			const coverage = relativeLandmarkCoverage(events, refs);
			expect(coverage.gatedWriters).toBe(2);
			expect(coverage.sessions).toBe(1);

			// 门槛口：给没通过门的条目点赞就是把噪声洗成证据，必须直接拒。
			await expect(
				reviewLandmark(ws.bb, "git-watch", "src/alpha.ts", "endorse"),
			).rejects.toThrow("记录型写者");
			await expect(
				reviewLandmark(ws.bb, "editor", "src/beta.ts", "endorse"),
			).rejects.toThrow("记录型写者");
			// 未注册的写者不再有「猜一个 kind」的余地：直接说不认识。
			await expect(
				reviewLandmark(ws.bb, "ghost", "src/alpha.ts", "endorse"),
			).rejects.toThrow("写者未注册");
			expect(isRecordingWriter({ id: "x", kind: "ci" })).toBe(false);
			expect([...RECORDING_WRITER_KINDS].sort()).toEqual(["git", "human"]);
		} finally {
			await ws.cleanup();
		}
	});
});

describe("分母口径开关（TF-0159）", () => {
	test("默认不切：不传 denominator 时仍是阈值口径；显式传才换尺子", async () => {
		const ws = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(ws.bb);
			const agent = await chat.create("A");
			// 真实工作形状：4 个文件各碰一两次，离地标线（10）差得远。
			for (const path of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
				await appendEdits(ws.bb, agent.id, path, 2);
			}
			const events = await ws.bb.events.all();
			const refs = [{ id: agent.id, kind: "agent" }];
			// 阈值口径：空集 → 判据不可计算（不是 0 分）。这就是切换的依据。
			const threshold = currentLandmarkAcceptance(events, refs);
			expect(threshold.denominator).toBe("threshold");
			expect(threshold.total).toBe(0);
			expect(threshold.endorsedShare).toBeNull();
			// 相对口径：同一个现场，非空且全是真任务文件。
			const relative = currentLandmarkAcceptance(
				events,
				refs,
				Date.now(),
				"human",
				{
					denominator: "session-top-k",
					topK: 3,
				},
			);
			expect(relative.denominator).toBe("session-top-k");
			expect(relative.topK).toBe(3);
			expect(relative.total).toBe(3);
			expect(relative.byWriter[0]!.total).toBe(3);
		} finally {
			await ws.cleanup();
		}
	});

	test("回填口径与展示口径不分家：候选集合里的每一条都必须回填得进去", async () => {
		const ws = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(ws.bb);
			const agent = await chat.create("A");
			for (const path of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
				await appendEdits(ws.bb, agent.id, path, 2);
			}
			const events = await ws.bb.events.all();
			// 这正是 2026-09-11 彩排踩过的坑：展示用一套口径、校验用另一套，界面上
			// 三条待办全部被拒。所以这里逐条回填**展示用的那份候选集合**。
			const shown = landmarkCandidates(events, agent.id, {
				denominator: "session-top-k",
				topK: 3,
			});
			expect(shown).toHaveLength(3);
			for (const handle of shown) {
				await reviewLandmark(ws.bb, agent.id, handle, "endorse");
			}
			const after = await ws.bb.events.all();
			const judgement = currentLandmarkAcceptance(
				after,
				[{ id: agent.id, kind: "agent" }],
				Date.now(),
				"human",
				{ denominator: "session-top-k" },
			);
			expect(judgement.reviewed).toBe(3);
			expect(judgement.legacyReviews).toBe(0);
			expect(
				landmarkCandidates(await ws.bb.events.all(), agent.id, {
					denominator: "threshold",
				}),
			).toHaveLength(0);
		} finally {
			await ws.cleanup();
		}
	});
});

describe("结论连续性（TF-0159 §2.2）", () => {
	test("集合外的旧结论只记 legacy：不删除、不改判、仍然查得到", async () => {
		const ws = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(ws.bb);
			const agent = await chat.create("A");
			// 5 个文件都过阈值线（6 次编辑 = 12 分），但 top-3 只收 3 个。
			const files = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
			for (const path of files) await appendEdits(ws.bb, agent.id, path, 6);

			const refs = [{ id: agent.id, kind: "agent" }];
			const events = await ws.bb.events.all();
			expect(
				landmarkCandidates(events, agent.id, { denominator: "threshold" }),
			).toHaveLength(5);
			const top = landmarkCandidates(events, agent.id, {
				denominator: "session-top-k",
				topK: 3,
			});
			expect(top).toHaveLength(3);

			// 人对 5 条都给了回答（旧口径下的完整人工答案）。
			for (const path of files) {
				await reviewLandmark(ws.bb, agent.id, path, "endorse");
			}
			const after = await ws.bb.events.all();
			// 结论一条都没丢：5 条事件仍然可查。
			expect(collectLandmarkReviews(after)).toHaveLength(5);
			const threshold = currentLandmarkAcceptance(after, refs);
			expect(threshold).toMatchObject({ total: 5, reviewed: 5, endorsed: 5 });
			const current = currentLandmarkAcceptance(
				after,
				refs,
				Date.now(),
				"human",
				{
					denominator: "session-top-k",
				},
			);
			// 3 条落在新集合里照旧计入；2 条落在集合外 → legacy 只计数。
			expect(current).toMatchObject({
				total: 3,
				reviewed: 3,
				endorsed: 3,
				legacyReviews: 2,
			});
			expect(current.endorsedShare).toBe(1);
			// legacy 不是「数据丢失」：两条老结论的 verdict 仍是 endorse。
			const legacyHandles = files.filter((path) => !top.includes(path));
			const kept = collectLandmarkReviews(after).filter((review) =>
				legacyHandles.includes(review.handle),
			);
			expect(kept).toHaveLength(2);
			expect(kept.every((review) => review.verdict === "endorse")).toBe(true);
		} finally {
			await ws.cleanup();
		}
	});

	test("抽样只影响问多少，不影响会话 DOI 总分的排序依据", async () => {
		const ws = await makeTempWorkbench();
		try {
			const chat = new ChatThreads(ws.bb);
			const busy = await chat.create("busy");
			const light = await chat.create("light");
			await appendEdits(ws.bb, busy.id, "src/hot.ts", 5);
			await appendEdits(ws.bb, busy.id, "src/warm.ts", 3);
			await appendEdits(ws.bb, light.id, "src/cold.ts", 1);
			const events = await ws.bb.events.all();
			// 抽样依据是「会话 DOI 总分降序」（tf-0159 §2.3），所以忙的会话排在前面。
			const totalOf = (id: string) =>
				sessionFileScores(events, id).reduce((sum, row) => sum + row.doi, 0);
			expect(totalOf(busy.id)).toBeGreaterThan(totalOf(light.id));
			expect(sessionFileTopK(events, busy.id, 3)).toEqual([
				"src/hot.ts",
				"src/warm.ts",
			]);
		} finally {
			await ws.cleanup();
		}
	});
});
