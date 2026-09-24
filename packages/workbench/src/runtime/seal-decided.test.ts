import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectChatStats } from "../chat/stats";
import { makeTempWorkbench } from "../test/fixtures";
import { pendingPremiseNotices } from "./delivery";
import type { StalePremiseClaim } from "./premises";
import { reconcilePremises } from "./premises";
import { decideSeal } from "./seal";
import { foldSealDecisions, SEAL_EVENT } from "./seal-counts";

/**
 * TF-0134：封印观测与降级模式。在这之前一次 block 不留任何痕迹，
 * 「那次封印对不对」这个问题没有数据来源。
 */

type Workbench = Awaited<ReturnType<typeof makeTempWorkbench>>;

/** A workbench with exactly one stale claim pending against writer `w`. */
async function withStaleClaim(): Promise<{
	ws: Workbench;
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
	return {
		ws,
		claims,
		stalePath: join(ws.projectDir, "src", "stale.ts"),
		freshPath: join(ws.projectDir, "src", "fresh.ts"),
	};
}

async function sealEvents(ws: Workbench) {
	return ws.bb.events.query({ type: SEAL_EVENT });
}

describe("封印决策可查询（TF-0134 验收一）", () => {
	test("一次真实 block 在事件日志里可见，且带上匹配到的声明", async () => {
		const { ws, claims, stalePath } = await withStaleClaim();
		try {
			const outcome = await decideSeal(ws.bb, {
				target: stalePath,
				writerId: "w",
				claims,
			});
			expect(outcome.decision).toBe("block");
			expect(outcome.hit).toBe(true);
			expect(outcome.matchedDeclarations).toEqual(["src/stale.ts"]);

			const events = await sealEvents(ws);
			expect(events).toHaveLength(1);
			const payload = events[0]!.payload as Record<string, unknown>;
			expect(payload.decision).toBe("block");
			expect(payload.writer).toBe("w");
			expect(payload.path).toBe("src/stale.ts");
			expect(payload.mode).toBe("block");
			expect(payload.matchedDeclarations).toEqual(["src/stale.ts"]);
			// 载荷只留路径，不留 claim 体：TF-0145 的行预算同样管着这条事件
			expect(JSON.stringify(payload).length).toBeLessThan(400);
		} finally {
			await ws.cleanup();
		}
	});

	test("放行也记账：没有命中的那次同样写一条 pass", async () => {
		const { ws, claims, freshPath } = await withStaleClaim();
		try {
			const outcome = await decideSeal(ws.bb, {
				target: freshPath,
				writerId: "w",
				claims,
			});
			expect(outcome.decision).toBe("pass");
			expect(outcome.hit).toBe(false);
			expect(outcome.matchedDeclarations).toEqual([]);
			// 只记阻断的日志算不出精度，所以放行必须同样落库
			expect(await sealEvents(ws)).toHaveLength(1);
		} finally {
			await ws.cleanup();
		}
	});
});

describe("off / warn 不隐藏原因（TF-0134 验收四）", () => {
	test("warn：写入放过去，但理由与命中照旧留在记录里", async () => {
		const { ws, claims, stalePath } = await withStaleClaim();
		try {
			const outcome = await decideSeal(ws.bb, {
				target: stalePath,
				writerId: "w",
				claims,
				mode: "warn",
			});
			expect(outcome.decision).toBe("warn");
			expect(outcome.hit).toBe(true);
			expect(outcome.reason).toContain("封印点");
			expect(outcome.matchedDeclarations).toEqual(["src/stale.ts"]);
		} finally {
			await ws.cleanup();
		}
	});

	test("off：不阻断也不静默——decision 是 pass 但 hit 仍为 true", async () => {
		const { ws, claims, stalePath } = await withStaleClaim();
		try {
			const outcome = await decideSeal(ws.bb, {
				target: stalePath,
				writerId: "w",
				claims,
				mode: "off",
			});
			expect(outcome.decision).toBe("pass");
			// 关掉的是打断，不是观测
			expect(outcome.hit).toBe(true);
			expect(outcome.reason).toContain("封印点");
			const payload = (await sealEvents(ws))[0]!.payload as Record<
				string,
				unknown
			>;
			expect(payload.hit).toBe(true);
			expect(payload.matchedDeclarations).toEqual(["src/stale.ts"]);
		} finally {
			await ws.cleanup();
		}
	});

	test("配置里的 seal.mode 生效，不必每次传参", async () => {
		const { ws, claims, stalePath } = await withStaleClaim();
		try {
			const config = await ws.bb.config.load();
			config.seal.mode = "warn";
			await ws.bb.config.save(config);
			const outcome = await decideSeal(ws.bb, {
				target: stalePath,
				writerId: "w",
				claims,
			});
			expect(outcome.mode).toBe("warn");
			expect(outcome.decision).toBe("warn");
		} finally {
			await ws.cleanup();
		}
	});
});

describe("连续阻断后自动降级（TF-0134 验收三）", () => {
	test("阈值 2：前两次阻断，第三次自动降级为 warn", async () => {
		const { ws, claims, stalePath } = await withStaleClaim();
		try {
			const config = await ws.bb.config.load();
			config.seal.consecutiveBlockLimit = 2;
			await ws.bb.config.save(config);

			const first = await decideSeal(ws.bb, {
				target: stalePath,
				writerId: "w",
				claims,
			});
			const second = await decideSeal(ws.bb, {
				target: stalePath,
				writerId: "w",
				claims,
			});
			const third = await decideSeal(ws.bb, {
				target: stalePath,
				writerId: "w",
				claims,
			});

			expect([first.decision, second.decision, third.decision]).toEqual([
				"block",
				"block",
				"warn",
			]);
			expect(third.downgraded).toBe(true);
			expect(third.priorBlockStreak).toBe(2);
			// 降级后 mode 仍是配置值，只有 effectiveMode 变了
			expect(third.mode).toBe("block");
			expect(third.effectiveMode).toBe("warn");

			// 降级必须持续：连击按「命中」而非「阻断」计数，否则降级一次就
			// 自己复位，变成 N 次阻断换一次放行的震荡
			const fourth = await decideSeal(ws.bb, {
				target: stalePath,
				writerId: "w",
				claims,
			});
			expect(fourth.decision).toBe("warn");
			expect(fourth.downgraded).toBe(true);
			expect(fourth.priorBlockStreak).toBe(3);
		} finally {
			await ws.cleanup();
		}
	});

	test("中间有一次未命中的放行就重置连击，另一个写者的连击互不影响", async () => {
		const { ws, claims, stalePath, freshPath } = await withStaleClaim();
		try {
			const config = await ws.bb.config.load();
			config.seal.consecutiveBlockLimit = 2;
			await ws.bb.config.save(config);

			await decideSeal(ws.bb, { target: stalePath, writerId: "w", claims });
			await decideSeal(ws.bb, { target: stalePath, writerId: "w", claims });
			// 一次放行打断连击
			await decideSeal(ws.bb, { target: freshPath, writerId: "w", claims });
			const afterReset = await decideSeal(ws.bb, {
				target: stalePath,
				writerId: "w",
				claims,
			});
			expect(afterReset.decision).toBe("block");
			expect(afterReset.priorBlockStreak).toBe(0);

			// 另一个写者从零开始算
			const other = await decideSeal(ws.bb, {
				target: stalePath,
				writerId: "other",
				claims,
			});
			expect(other.decision).toBe("block");
			expect(other.priorBlockStreak).toBe(0);
		} finally {
			await ws.cleanup();
		}
	});
});

describe("stats 里的封印计数（TF-0134 验收二）", () => {
	test("命中、阻断、放行三个数分别可读", async () => {
		const { ws, claims, stalePath, freshPath } = await withStaleClaim();
		try {
			await decideSeal(ws.bb, { target: stalePath, writerId: "w", claims });
			await decideSeal(ws.bb, {
				target: stalePath,
				writerId: "w",
				claims,
				mode: "warn",
			});
			await decideSeal(ws.bb, { target: freshPath, writerId: "w", claims });

			const stats = await collectChatStats(ws.bb);
			expect(stats.seal.decisions).toBe(3);
			expect(stats.seal.blocked).toBe(1);
			expect(stats.seal.warned).toBe(1);
			expect(stats.seal.passed).toBe(1);
			expect(stats.seal.hits).toBe(2);
			expect(stats.seal.hitsAllowed).toBe(1);
			// byMode 按「当时生效的模式」计数，不是按结局：block 模式下的
			// 那次阻断与那次放行都算 block 模式
			expect(stats.seal.byMode.block).toBe(2);
			expect(stats.seal.byMode.warn).toBe(1);
			expect(stats.seal.lastDecisionAt).not.toBeNull();
		} finally {
			await ws.cleanup();
		}
	});

	test("一次封印都没跑过时全为零，不报假数", async () => {
		const ws = await makeTempWorkbench();
		try {
			const stats = await collectChatStats(ws.bb);
			expect(stats.seal.decisions).toBe(0);
			expect(stats.seal.hits).toBe(0);
			expect(stats.seal.lastDecisionAt).toBeNull();
		} finally {
			await ws.cleanup();
		}
	});

	test("坏 payload 不进聚合：缺 decision 的记录被跳过", () => {
		const folded = foldSealDecisions([
			{
				timestamp: "2026-09-05T00:00:00.000Z",
				source: "runtime",
				type: SEAL_EVENT,
				payload: { writer: "w", path: "src/a.ts" },
			},
			{
				timestamp: "2026-09-05T00:00:01.000Z",
				source: "runtime",
				type: SEAL_EVENT,
				payload: {
					writer: "w",
					path: "src/a.ts",
					decision: "block",
					hit: true,
					matchedDeclarations: ["src/a.ts"],
					mode: "block",
					effectiveMode: "block",
					downgraded: false,
				},
			},
		]);
		expect(folded.decisions).toBe(1);
		expect(folded.blocked).toBe(1);
		expect(folded.hits).toBe(1);
	});
});

/**
 * P0-2：`protection.readonlyAreas` 曾经只声明、只校验、`config set` 还打印成功，
 * 但全仓没有任何消费者——一个"安全形状"的选项实际上是装饰。这些用例把它钉住：
 * 声明为只读的路径必须真的拦，且不能被 `seal.mode` 或降级机制关掉。
 */
describe("protection.readonlyAreas 真的拦写（P0-2）", () => {
	test("只读路径即使 seal.mode=off 也被拒绝，并记为 readonly_area", async () => {
		const ws = await makeTempWorkbench();
		try {
			await ws.bb.config.save({
				protection: { readonlyAreas: ["docs/generated"] },
				seal: { mode: "off" },
			});
			const outcome = await decideSeal(ws.bb, {
				target: "docs/generated/api.md",
				writerId: "w",
				claims: [],
			});
			expect(outcome.decision).toBe("block");
			expect(outcome.kind).toBe("readonly_area");
			expect(outcome.hit).toBe(true);
			expect(outcome.matchedDeclarations).toEqual(["docs/generated"]);
			expect(outcome.reason).toContain("只读区域");
			// 结论必须落进事件日志，否则"拦了没有"仍然无从查证。
			expect(await sealEvents(ws)).toHaveLength(1);
		} finally {
			await ws.cleanup();
		}
	});

	test("只读拒绝不冒充前提封印：readonlyBlocks 单独计，hits 与 premiseBlocked 不动", async () => {
		const ws = await makeTempWorkbench();
		try {
			await ws.bb.config.save({
				protection: { readonlyAreas: ["docs/generated"] },
			});
			await decideSeal(ws.bb, {
				target: "docs/generated/api.md",
				writerId: "w",
				claims: [],
			});
			const folded = foldSealDecisions(await sealEvents(ws));
			expect(folded.blocked).toBe(1);
			expect(folded.readonlyBlocks).toBe(1);
			expect(folded.premiseBlocked).toBe(0);
			expect(folded.hits).toBe(0);
		} finally {
			await ws.cleanup();
		}
	});

	test("只读区域之外的写入不受影响", async () => {
		const ws = await makeTempWorkbench();
		try {
			await ws.bb.config.save({
				protection: { readonlyAreas: ["docs/generated"] },
			});
			const outcome = await decideSeal(ws.bb, {
				target: "src/app.ts",
				writerId: "w",
				claims: [],
			});
			expect(outcome.decision).toBe("pass");
			expect(outcome.kind).toBeNull();
		} finally {
			await ws.cleanup();
		}
	});

	test("只读拒绝既不推进也不打断降级连击", async () => {
		const ws = await makeTempWorkbench();
		try {
			await ws.bb.config.save({
				protection: { readonlyAreas: ["docs/generated"] },
				seal: { mode: "block", consecutiveBlockLimit: 1 },
			});
			await decideSeal(ws.bb, {
				target: "docs/generated/a.md",
				writerId: "w",
				claims: [],
			});
			const second = await decideSeal(ws.bb, {
				target: "docs/generated/b.md",
				writerId: "w",
				claims: [],
			});
			// limit=1 时第二次前提命中就会降级；只读拒绝不能顶替那次命中。
			expect(second.priorBlockStreak).toBe(0);
			expect(second.downgraded).toBe(false);
			expect(second.decision).toBe("block");
		} finally {
			await ws.cleanup();
		}
	});
});
