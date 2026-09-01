import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../git";
import { makeTempWorkbench } from "../test/fixtures";
import {
	overlappingWrites,
	parseMergeTree,
	predictConflicts,
	recentAuthors,
	runMergeGuard,
} from "./merge-guard";

/**
 * The cheap merge safety net (R2, TF-0079). Two properties are load-bearing:
 * a predicted conflict must be a REAL conflict (no heuristics, no false
 * positives), and a routine overlap must stay silent (or the channel dies).
 */

type Fixture = Awaited<ReturnType<typeof makeTempWorkbench>>;

async function gitInit(ws: Fixture): Promise<void> {
	await git(["init", "-q"], ws.projectDir);
	await git(["config", "user.email", "t@example.com"], ws.projectDir);
	await git(["config", "user.name", "Tester"], ws.projectDir);
}

async function commitAll(ws: Fixture, message: string): Promise<void> {
	await git(["add", "-A"], ws.projectDir);
	await git(["commit", "-qm", message], ws.projectDir);
}

describe("parseMergeTree（零误报的冲突预测）", () => {
	test("干净合并：只有 tree oid，退出码 0", () => {
		expect(parseMergeTree("9b1f0e...\n", 0)).toEqual([]);
	});

	test("冲突：oid 之后到空行之间是冲突路径", () => {
		const stdout = [
			"7ea203db32989f72a1ade8853596f83bff912ae2",
			"src/a.ts",
			"src/b.ts",
			"",
			"Auto-merging src/a.ts",
			"CONFLICT (content): Merge conflict in src/a.ts",
		].join("\n");
		expect(parseMergeTree(stdout, 1)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("退出码非 0/1 是 git 出错，不是冲突", () => {
		// 调用方负责看 code；这里只保证不会把错误输出当成路径
		expect(parseMergeTree("fatal: not a valid ref\n", 128)).toEqual([]);
	});
});

describe("合并安全网（R2 · TF-0079）", () => {
	test("改同一处 → 预测冲突；改不同文件 → 干净", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(
				join(ws.projectDir, "src", "shared.ts"),
				"export const v = 0;",
				"utf8",
			);
			await gitInit(ws);
			await commitAll(ws, "base");
			// 三条分支都从 base 拉，互不继承对方的改动
			for (const branch of ["b1", "b2", "clean"]) {
				await git(["branch", branch], ws.projectDir);
			}

			// b1 与 b2 改同一处 → 真冲突
			await git(["checkout", "-q", "b1"], ws.projectDir);
			await writeFile(
				join(ws.projectDir, "src", "shared.ts"),
				"export const v = 1;",
				"utf8",
			);
			await commitAll(ws, "b1");

			await git(["checkout", "-q", "b2"], ws.projectDir);
			await writeFile(
				join(ws.projectDir, "src", "shared.ts"),
				"export const v = 2;",
				"utf8",
			);
			await commitAll(ws, "b2");

			// clean 碰的是另一个文件 → 与谁都不冲突
			await git(["checkout", "-q", "clean"], ws.projectDir);
			await writeFile(join(ws.projectDir, "src", "only-clean.ts"), "x", "utf8");
			await commitAll(ws, "clean");

			const predictions = await predictConflicts(ws.projectDir, [
				"b1",
				"b2",
				"clean",
			]);
			const find = (a: string, b: string) =>
				predictions.find((p) => p.a === a && p.b === b);
			expect(find("b1", "b2")?.conflicting).toEqual(["src/shared.ts"]);
			expect(find("b1", "b2")?.error).toBeUndefined();
			expect(find("b1", "clean")?.conflicting).toEqual([]);
			expect(find("b2", "clean")?.conflicting).toEqual([]);
		} finally {
			await ws.cleanup();
		}
	}, 90_000);

	test("N=5 的十对预测并发跑完，并记录实测耗时", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "base.ts"), "v0", "utf8");
			await gitInit(ws);
			await commitAll(ws, "base");
			const refs: string[] = [];
			for (let i = 1; i <= 5; i += 1) {
				await git(["checkout", "-q", "-b", `b${i}`], ws.projectDir);
				await writeFile(
					join(ws.projectDir, "src", `f${i}.ts`),
					`v${i}`,
					"utf8",
				);
				await commitAll(ws, `b${i}`);
				refs.push(`b${i}`);
			}

			const started = Date.now();
			const predictions = await predictConflicts(ws.projectDir, refs);
			const elapsed = Date.now() - started;
			expect(predictions).toHaveLength(10);
			expect(predictions.flatMap((p) => p.error ?? [])).toEqual([]);
			// 五个分支各写各的文件：不该有任何冲突
			expect(predictions.flatMap((p) => p.conflicting)).toEqual([]);
			// 本机进程启动约 300ms／次，十对并发约 1–2 秒；
			// 任务书给的 1 秒是按 33ms／次的机器定的，这里只做宽松上限
			console.log(`N=5 共 10 对并发预测耗时：${elapsed}ms`);
			expect(elapsed).toBeLessThan(20_000);
		} finally {
			await ws.cleanup();
		}
	}, 120_000);

	test("写集重叠：同一文件被两个写者写过才进账本", async () => {
		const ws = await makeTempWorkbench();
		try {
			await ws.bb.sessions.register("wa", "agent", "A");
			await ws.bb.sessions.register("wb", "agent", "B");
			await ws.bb.sessions.recordActivity("wa", {
				activity: "a1",
				agent: "wa",
				used: [],
				generated: [{ path: "src/shared.ts" }, { path: "src/only-a.ts" }],
			});
			await ws.bb.sessions.recordActivity("wb", {
				activity: "a1",
				agent: "wb",
				used: [],
				generated: [{ path: "src/shared.ts" }, { path: "src/only-b.ts" }],
			});
			const overlaps = await overlappingWrites(ws.bb);
			expect(overlaps).toHaveLength(1);
			expect(overlaps[0]!.a).toBe("wa");
			expect(overlaps[0]!.b).toBe("wb");
			expect(overlaps[0]!.paths).toEqual(["src/shared.ts"]);
		} finally {
			await ws.cleanup();
		}
	});

	test("历史作者数：单人文件 vs 多人共享文件", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "solo.ts"), "a", "utf8");
			await writeFile(join(ws.projectDir, "src", "shared.ts"), "b", "utf8");
			await gitInit(ws);
			await commitAll(ws, "base");

			// shared.ts 由第二个人再提交一次
			await writeFile(join(ws.projectDir, "src", "shared.ts"), "b2", "utf8");
			await git(["add", "-A"], ws.projectDir);
			await git(
				[
					"-c",
					"user.name=Other",
					"-c",
					"user.email=o@example.com",
					"commit",
					"-qm",
					"other",
				],
				ws.projectDir,
			);

			expect(await recentAuthors(ws.projectDir, "src/solo.ts")).toEqual([
				"Tester",
			]);
			expect(
				(await recentAuthors(ws.projectDir, "src/shared.ts")).sort(),
			).toEqual(["Other", "Tester"]);
		} finally {
			await ws.cleanup();
		}
	}, 90_000);

	test("只在重叠反常时告警，常规共享文件保持沉默", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "solo.ts"), "a", "utf8");
			await writeFile(join(ws.projectDir, "src", "shared.ts"), "b", "utf8");
			await gitInit(ws);
			await commitAll(ws, "base");
			await writeFile(join(ws.projectDir, "src", "shared.ts"), "b2", "utf8");
			await git(["add", "-A"], ws.projectDir);
			await git(
				[
					"-c",
					"user.name=Other",
					"-c",
					"user.email=o@example.com",
					"commit",
					"-qm",
					"other",
				],
				ws.projectDir,
			);

			// 两个写者同时碰了 solo.ts（反常）和 shared.ts（常规）
			for (const id of ["wa", "wb"]) {
				await ws.bb.sessions.register(id, "agent", id);
				await ws.bb.sessions.recordActivity(id, {
					activity: "a1",
					agent: id,
					used: [],
					generated: [{ path: "src/solo.ts" }, { path: "src/shared.ts" }],
				});
			}

			const result = await runMergeGuard(ws.bb, []);
			expect(result.predictions).toHaveLength(0);
			// 只有反常的那条进告警
			expect(result.warnings.map((w) => w.path)).toEqual(["src/solo.ts"]);
			expect(result.warnings[0]!.authors).toEqual(["Tester"]);
			expect(result.warnings[0]!.reason).toContain("不是常共享的文件");
		} finally {
			await ws.cleanup();
		}
	}, 90_000);

	test("git 已判出冲突的文件不再重复告警", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(join(ws.projectDir, "src", "conflict.ts"), "v0", "utf8");
			await gitInit(ws);
			await commitAll(ws, "base");
			await git(["branch", "b1"], ws.projectDir);
			await git(["branch", "b2"], ws.projectDir);

			await git(["checkout", "-q", "b1"], ws.projectDir);
			await writeFile(join(ws.projectDir, "src", "conflict.ts"), "v1", "utf8");
			await commitAll(ws, "b1");
			await git(["checkout", "-q", "b2"], ws.projectDir);
			await writeFile(join(ws.projectDir, "src", "conflict.ts"), "v2", "utf8");
			await commitAll(ws, "b2");
			await git(["checkout", "-q", "b1"], ws.projectDir);

			for (const id of ["wa", "wb"]) {
				await ws.bb.sessions.register(id, "agent", id);
				await ws.bb.sessions.recordActivity(id, {
					activity: "a1",
					agent: id,
					used: [],
					generated: [{ path: "src/conflict.ts" }],
				});
			}

			const result = await runMergeGuard(ws.bb, ["b1", "b2"]);
			expect(result.predictions[0]?.conflicting).toEqual(["src/conflict.ts"]);
			// 真冲突已经报过了，重叠告警不再重复一遍
			expect(result.warnings).toHaveLength(0);
		} finally {
			await ws.cleanup();
		}
	}, 90_000);
});
