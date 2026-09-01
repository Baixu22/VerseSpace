import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { drainPremiseQueue, pendingPremiseNotices } from "./delivery";
import { reconcilePremises } from "./premises";

/**
 * R2 delivery (TF-0077). The predicate layers decide WHAT is stale; this
 * decides whether the writer ever hears about it. Two properties matter more
 * than throughput: never re-deliver, and never lose a notice to a broken
 * channel or an absent one.
 */

async function seedStalePremise(
	ws: Awaited<ReturnType<typeof makeTempWorkbench>>,
) {
	await mkdir(join(ws.projectDir, "src"), { recursive: true });
	await writeFile(
		join(ws.projectDir, "src", "a.ts"),
		"export const a = 1;",
		"utf8",
	);
	await ws.bb.sessions.register("w", "agent", "W");
	await ws.bb.sessions.recordActivity("w", {
		activity: "a1",
		agent: "w",
		used: [{ path: "src/a.ts", version: "stale", durability: "volatile" }],
		generated: [],
	});
	await writeFile(
		join(ws.projectDir, "src", "a.ts"),
		"export const a = 2;",
		"utf8",
	);
	await reconcilePremises(ws.bb);
}

describe("前提失效通知投递（R2 · TF-0077）", () => {
	test("检测到但未投递的通知会进入待投递队列", async () => {
		const ws = await makeTempWorkbench();
		try {
			await seedStalePremise(ws);
			const pending = await pendingPremiseNotices(ws.bb);
			expect(pending).toHaveLength(1);
			expect(pending[0]!.writerId).toBe("w");
			expect(pending[0]!.claims.map((c) => c.path)).toEqual(["src/a.ts"]);
			expect(pending[0]!.message).toContain("前提失效");
			expect(pending[0]!.message).toContain("src/a.ts");
		} finally {
			await ws.cleanup();
		}
	});

	test("投递一次之后不再重复投递", async () => {
		const ws = await makeTempWorkbench();
		try {
			await seedStalePremise(ws);
			const seen: string[] = [];
			const deliver = async (writerId: string, message: string) => {
				seen.push(writerId);
				expect(message).toContain("前提失效");
				return true;
			};

			const first = await drainPremiseQueue(ws.bb, { deliver });
			expect(first.delivered).toHaveLength(1);
			expect(first.pending).toHaveLength(0);
			expect(seen).toEqual(["w"]);

			// 第二次：那条已经在事件日志里记为 delivered，不该再来一遍
			const second = await drainPremiseQueue(ws.bb, { deliver });
			expect(second.delivered).toHaveLength(0);
			expect(second.pending).toHaveLength(0);
			expect(seen).toEqual(["w"]);
			expect(await pendingPremiseNotices(ws.bb)).toHaveLength(0);
		} finally {
			await ws.cleanup();
		}
	});

	test("通道返回 false 时通知留在队列里，不丢", async () => {
		const ws = await makeTempWorkbench();
		try {
			await seedStalePremise(ws);
			const result = await drainPremiseQueue(ws.bb, {
				deliver: async () => false,
			});
			expect(result.delivered).toHaveLength(0);
			expect(result.pending).toHaveLength(1);
			expect(await pendingPremiseNotices(ws.bb)).toHaveLength(1);
		} finally {
			await ws.cleanup();
		}
	});

	test("通道抛异常时同样不丢，且不让异常冒出去", async () => {
		const ws = await makeTempWorkbench();
		try {
			await seedStalePremise(ws);
			const result = await drainPremiseQueue(ws.bb, {
				deliver: async () => {
					throw new Error("stdin 已关闭");
				},
			});
			expect(result.delivered).toHaveLength(0);
			expect(result.pending).toHaveLength(1);
		} finally {
			await ws.cleanup();
		}
	});

	test("没有投递通道时是纯查看，什么都不写", async () => {
		const ws = await makeTempWorkbench();
		try {
			await seedStalePremise(ws);
			const before = (await ws.bb.events.query({})).length;
			const result = await drainPremiseQueue(ws.bb);
			expect(result.delivered).toHaveLength(0);
			expect(result.pending).toHaveLength(1);
			expect((await ws.bb.events.query({})).length).toBe(before);
		} finally {
			await ws.cleanup();
		}
	});

	test("同一文件被改两次只留最新一条，不叠加", async () => {
		const ws = await makeTempWorkbench();
		try {
			await seedStalePremise(ws);
			// 再改一次：currentVersion 变了，旧的这条自动被最新状态取代
			await writeFile(
				join(ws.projectDir, "src", "a.ts"),
				"export const a = 3;",
				"utf8",
			);
			await reconcilePremises(ws.bb);
			const pending = await pendingPremiseNotices(ws.bb);
			expect(pending).toHaveLength(1);
			expect(pending[0]!.claims).toHaveLength(1);
			expect(pending[0]!.claims[0]!.path).toBe("src/a.ts");
		} finally {
			await ws.cleanup();
		}
	});

	test("多个写者各自成条，互不混淆", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(
				join(ws.projectDir, "src", "a.ts"),
				"export const a = 1;",
				"utf8",
			);
			await writeFile(
				join(ws.projectDir, "src", "b.ts"),
				"export const b = 1;",
				"utf8",
			);
			for (const [id, path] of [
				["wa", "src/a.ts"],
				["wb", "src/b.ts"],
			] as const) {
				await ws.bb.sessions.register(id, "agent", id);
				await ws.bb.sessions.recordActivity(id, {
					activity: "a1",
					agent: id,
					used: [{ path, version: "stale", durability: "volatile" }],
					generated: [],
				});
			}
			await writeFile(
				join(ws.projectDir, "src", "a.ts"),
				"export const a = 2;",
				"utf8",
			);
			await writeFile(
				join(ws.projectDir, "src", "b.ts"),
				"export const b = 2;",
				"utf8",
			);
			await reconcilePremises(ws.bb);

			const pending = await pendingPremiseNotices(ws.bb);
			expect(pending.map((p) => p.writerId).sort()).toEqual(["wa", "wb"]);
			const result = await drainPremiseQueue(ws.bb, {
				deliver: async () => true,
			});
			expect(result.delivered).toHaveLength(2);
		} finally {
			await ws.cleanup();
		}
	});
});
