import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { pendingPremiseNotices } from "./delivery";
import type { StalePremiseClaim } from "./premises";
import { reconcilePremises } from "./premises";
import { decideSeal } from "./seal";
import { SEAL_EVENT } from "./seal-counts";
import { foldSealReviews, reviewSeal, sealReviewTotals } from "./seal-review";

/**
 * 封印复核（TF-0134 的延伸）。block 只证明「拒绝发生过」，不证明「拒绝
 * 是对的」；护城河数字 A 要的是「真实且正确的 block」，而「正确」只能由
 * 人补上。复核以 source=human 的 seal.reviewed 追加进同一条日志。
 */

type Workbench = Awaited<ReturnType<typeof makeTempWorkbench>>;

/** 一个带一条 block 记录和一条 pass 记录的工作台，返回各自的事件 id。 */
async function withSealDecisions(): Promise<{
	ws: Workbench;
	blockEventId: string;
	passEventId: string;
	claims: StalePremiseClaim[];
	stalePath: string;
	freshPath: string;
}> {
	const ws = await makeTempWorkbench();
	await mkdir(join(ws.projectDir, "src"), { recursive: true });
	await writeFile(
		join(ws.projectDir, "src", "stale.ts"),
		"export const a = 1;\n",
		"utf8",
	);
	await writeFile(
		join(ws.projectDir, "src", "fresh.ts"),
		"export const b = 1;\n",
		"utf8",
	);
	await ws.bb.sessions.register("w", "agent", "W");
	await ws.bb.sessions.recordActivity("w", {
		activity: "a1",
		agent: "w",
		used: [{ path: "src/stale.ts", version: "stale", durability: "volatile" }],
		generated: [],
	});
	await writeFile(
		join(ws.projectDir, "src", "stale.ts"),
		"export const a = 2;\n",
		"utf8",
	);
	await reconcilePremises(ws.bb);
	const claims = (await pendingPremiseNotices(ws.bb)).flatMap(
		(notice) => notice.claims,
	);
	const block = await decideSeal(ws.bb, {
		target: join(ws.projectDir, "src", "stale.ts"),
		writerId: "w",
		claims,
	});
	const pass = await decideSeal(ws.bb, {
		target: join(ws.projectDir, "src", "fresh.ts"),
		writerId: "w",
		claims,
	});
	expect(block.decision).toBe("block");
	expect(pass.decision).toBe("pass");
	const events = await ws.bb.events.query({ type: SEAL_EVENT });
	const idOf = (path: string) =>
		events.find(
			(event) => (event.payload as Record<string, unknown>).path === path,
		)?.id;
	return {
		ws,
		blockEventId: idOf("src/stale.ts")!,
		passEventId: idOf("src/fresh.ts")!,
		claims,
		stalePath: join(ws.projectDir, "src", "stale.ts"),
		freshPath: join(ws.projectDir, "src", "fresh.ts"),
	};
}

function sealEvent(id: string, decision: string) {
	return {
		id,
		timestamp: "2026-09-06T00:00:00.000Z",
		source: "runtime",
		type: SEAL_EVENT,
		payload: {
			writer: "w",
			path: "src/a.ts",
			decision,
			hit: true,
			matchedDeclarations: ["src/a.ts"],
			mode: "block",
			effectiveMode: "block",
			downgraded: false,
		},
	};
}

function reviewEvent(id: string, overrides?: Record<string, unknown>) {
	return {
		id,
		timestamp: "2026-09-06T00:01:00.000Z",
		source: "human",
		type: "seal.reviewed",
		payload: {
			sealEventId: "se-1",
			correct: true,
			reason: "文件确实已被别人改写",
			...overrides,
		},
	};
}

describe("封印复核落库", () => {
	test("对一次真实 block 的人工复核带依据写进日志，source 是 human", async () => {
		const { ws, blockEventId } = await withSealDecisions();
		try {
			const event = await reviewSeal(
				ws.bb,
				blockEventId,
				true,
				"该文件确实已被并行写者改写",
			);
			expect(event.id).toBeString();
			expect(event.type).toBe("seal.reviewed");
			expect(event.source).toBe("human");
			expect(event.payload).toMatchObject({
				sealEventId: blockEventId,
				correct: true,
				reason: "该文件确实已被并行写者改写",
			});
			const stored = await ws.bb.events.query({ type: "seal.reviewed" });
			expect(stored).toHaveLength(1);
		} finally {
			await ws.cleanup();
		}
	});

	test("复核必须说明依据：空白依据被拒绝且不留事件", async () => {
		const { ws, blockEventId } = await withSealDecisions();
		try {
			await expect(
				reviewSeal(ws.bb, blockEventId, true, "   "),
			).rejects.toThrow("封印复核必须说明依据");
			expect(await ws.bb.events.query({ type: "seal.reviewed" })).toHaveLength(
				0,
			);
		} finally {
			await ws.cleanup();
		}
	});

	test("不存在的封印事件 id 不能复核", async () => {
		const { ws } = await withSealDecisions();
		try {
			await expect(
				reviewSeal(ws.bb, "no-such-event", true, "依据"),
			).rejects.toThrow("未找到对应的封印阻断事件");
		} finally {
			await ws.cleanup();
		}
	});

	test("放行与降级警告不是阻断，不接受复核", async () => {
		const { ws, passEventId, claims, stalePath } = await withSealDecisions();
		try {
			await expect(
				reviewSeal(ws.bb, passEventId, true, "依据"),
			).rejects.toThrow("未找到对应的封印阻断事件");
			const warn = await decideSeal(ws.bb, {
				target: stalePath,
				writerId: "w",
				claims,
				mode: "warn",
			});
			expect(warn.decision).toBe("warn");
			const warnId = (await ws.bb.events.query({ type: SEAL_EVENT })).at(-1)!
				.id!;
			await expect(reviewSeal(ws.bb, warnId, true, "依据")).rejects.toThrow(
				"未找到对应的封印阻断事件",
			);
		} finally {
			await ws.cleanup();
		}
	});
});

describe("复核投影 foldSealReviews", () => {
	test("复核只在阻断上成行：写者与人工结论一并可读", () => {
		const rows = foldSealReviews([
			sealEvent("se-1", "block"),
			reviewEvent("rv-1"),
		]);
		expect(rows).toEqual([
			{
				sealEventId: "se-1",
				reviewEventId: "rv-1",
				writer: "w",
				correct: true,
				reason: "文件确实已被别人改写",
			},
		]);
	});

	test("非阻断与无事件身份的复核不成行", () => {
		expect(
			foldSealReviews([sealEvent("se-1", "pass"), reviewEvent("rv-1")]),
		).toEqual([]);
		expect(foldSealReviews([reviewEvent("rv-1")])).toEqual([]);
	});

	test("只有人写的复核才算数，坏 payload 一律跳过", () => {
		const agentReview = { ...reviewEvent("rv-1"), source: "agent" };
		expect(foldSealReviews([sealEvent("se-1", "block"), agentReview])).toEqual(
			[],
		);
		for (const payload of [
			{ correct: true, reason: "  " },
			{ correct: true },
			{ sealEventId: "se-1", correct: "yes", reason: "依据" },
			null,
		]) {
			expect(
				foldSealReviews([
					sealEvent("se-1", "block"),
					{
						...reviewEvent("rv-1"),
						payload: payload as Record<string, unknown>,
					},
				]),
			).toEqual([]);
		}
	});

	test("同一封印复核两次时保留最新结论，修正以新事件追加", () => {
		const rows = foldSealReviews([
			sealEvent("se-1", "block"),
			reviewEvent("rv-1"),
			reviewEvent("rv-2", { correct: false, reason: "当时文件并未过时" }),
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			sealEventId: "se-1",
			reviewEventId: "rv-2",
			correct: false,
			reason: "当时文件并未过时",
		});
	});
});

describe("复核计数 sealReviewTotals", () => {
	test("正确与错误分开计数，agent 复核与未复核 block 不计入", () => {
		const totals = sealReviewTotals([
			sealEvent("se-1", "block"),
			sealEvent("se-2", "block"),
			sealEvent("se-3", "block"),
			reviewEvent("rv-1"),
			reviewEvent("rv-2", {
				sealEventId: "se-2",
				correct: false,
				reason: "误伤",
			}),
			// agent 写的复核不算数；第三个 block 保持未复核
			{
				...reviewEvent("rv-3", { sealEventId: "se-3", reason: "无效来源" }),
				source: "agent",
			},
		]);
		expect(totals).toEqual({ total: 2, correct: 1, incorrect: 1 });
	});

	test("空事件流得全零", () => {
		expect(sealReviewTotals([])).toEqual({
			total: 0,
			correct: 0,
			incorrect: 0,
		});
	});
});
