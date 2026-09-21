import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../git";
import { parseMergeTreeOutput, probeMergeTree } from "../git/merge-tree";
import { makeTempWorkbench } from "../test/fixtures";
import {
	conflictedPaths,
	overlappingWrites,
	predictConflicts,
	preflightPair,
	recentAuthors,
	runMergeGuard,
} from "./merge-guard";

/**
 * The cheap merge safety net (R2, TF-0079). Two properties are load-bearing:
 * a predicted conflict must be a REAL conflict (no heuristics, no false
 * positives), and a routine overlap must stay silent (or the channel dies).
 */

type Fixture = Awaited<ReturnType<typeof makeTempWorkbench>>;

// Ambient GIT_AUTHOR_* / GIT_COMMITTER_* outrank local git config; pin identity.
function gitIdentityEnv(name: string, email: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_AUTHOR_NAME: name,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: name,
		GIT_COMMITTER_EMAIL: email,
	};
}

const testerEnv = gitIdentityEnv("Tester", "t@example.com");
const otherEnv = gitIdentityEnv("Other", "o@example.com");

async function gitInit(ws: Fixture): Promise<void> {
	await git(["init", "-q"], ws.projectDir);
	await git(["config", "user.email", "t@example.com"], ws.projectDir);
	await git(["config", "user.name", "Tester"], ws.projectDir);
}

async function commitAll(
	ws: Fixture,
	message: string,
	env: NodeJS.ProcessEnv = testerEnv,
): Promise<void> {
	await git(["add", "-A"], ws.projectDir);
	await git(["commit", "-qm", message], ws.projectDir, env);
}

describe("parseMergeTreeOutput（只在认得出来时才算结论）", () => {
	test("冲突：oid 之后到空行之间是冲突路径", () => {
		const stdout = [
			"7ea203db32989f72a1ade8853596f83bff912ae2",
			"src/a.ts",
			"src/b.ts",
			"",
			"Auto-merging src/a.ts",
			"CONFLICT (content): Merge conflict in src/a.ts",
		].join("\n");
		expect(parseMergeTreeOutput(stdout)).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("认不出来时是 null，不是空数组", () => {
		// 旧实现返回 []，而调用方把 [] 读成「无冲突」—— 两者必须分得开，
		// 否则「没拿到结论」会被发布成「合并干净」。
		expect(parseMergeTreeOutput("fatal: not a valid ref\n")).toBeNull();
		expect(parseMergeTreeOutput("")).toBeNull();
	});

	test("老式 trivial merge-tree 的三列格式：不把对象哈希当路径", () => {
		// 实测：git < 2.38 的 merge-tree 输出 `<mode> <oid> <stage>\t<path>`，
		// 首行同样是 tree oid，所以只有逐行指纹能识破它。
		const stdout = [
			"5ae77cff7d6ceb9eeddf12c6b21e4f8ac4add9f6",
			"100644 495181cc2521585811d0963c45548eca9957c026 1\ta.txt",
			"100644 3254187abcc8c01382bb24ca6475c88e43f7ce35 2\ta.txt",
			"",
			"Auto-merging a.txt",
		].join("\n");
		expect(parseMergeTreeOutput(stdout)).toBeNull();
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
			expect(find("b1", "b2")?.preflight).toEqual({
				kind: "conflicts",
				paths: ["src/shared.ts"],
			});
			expect(find("b1", "clean")?.preflight).toEqual({ kind: "clear" });
			expect(find("b2", "clean")?.preflight).toEqual({ kind: "clear" });
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
			// 五个分支各写各的文件：十对都该是「有结论的干净」，不是「没拿到结论」
			expect(predictions.filter((p) => p.preflight.kind !== "clear")).toEqual(
				[],
			);
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
			await git(["commit", "-qm", "other"], ws.projectDir, otherEnv);

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
			await git(["commit", "-qm", "other"], ws.projectDir, otherEnv);

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
			expect(result.predictions[0]?.preflight).toEqual({
				kind: "conflicts",
				paths: ["src/conflict.ts"],
			});
			// 真冲突已经报过了，重叠告警不再重复一遍
			expect(result.warnings).toHaveLength(0);
		} finally {
			await ws.cleanup();
		}
	}, 90_000);
});

/**
 * TF-0208. These cases come from probing a real git (2.51) rather than from
 * imagining its output: `merge-tree` answers exit code 1 both for "they
 * conflict" and for "I won't answer", and the old reader collapsed the second
 * into an empty conflict list — a clean bill of health nobody issued. Every
 * assertion below is of the form "must not report clear".
 */
describe("预检结论的四臂（没有结论就说没有结论）", () => {
	test("本机 git 支持 merge-tree --write-tree", async () => {
		const ws = await makeTempWorkbench();
		try {
			await gitInit(ws);
			await commitAll(ws, "base");
			expect(await probeMergeTree(ws.projectDir)).toEqual({
				kind: "supported",
			});
		} finally {
			await ws.cleanup();
		}
	}, 60_000);

	test("ref 不存在 → unresolved，不是「合并干净」", async () => {
		// 真实 git：code=1、stdout 为空、stderr 里是 "not something we can merge"。
		const ws = await makeTempWorkbench();
		try {
			await gitInit(ws);
			await commitAll(ws, "base");
			const support = await probeMergeTree(ws.projectDir);
			const preflight = await preflightPair(
				ws.projectDir,
				"HEAD",
				"refs/heads/never-created",
				support,
			);
			expect(preflight.kind).toBe("unresolved");
			const reason = preflight.kind === "unresolved" ? preflight.reason : "";
			expect(reason).toContain("not something we can merge");
			// 这条是回归的要害：路径列表必须为空，且不能因此被当成干净
			expect(conflictedPaths(preflight)).toEqual([]);
		} finally {
			await ws.cleanup();
		}
	}, 60_000);

	test("零提交仓库里的 HEAD → unresolved（dispatch 的真实路径）", async () => {
		// scheduler/merge-guard.ts 在分支尚未创建时会 refs.add("HEAD")，
		// 而 createWorktree 要求仓库至少有一个 commit —— 这条路上
		// 老实现会报告「合并干净」。
		const ws = await makeTempWorkbench();
		try {
			await gitInit(ws);
			const support = await probeMergeTree(ws.projectDir);
			const preflight = await preflightPair(
				ws.projectDir,
				"HEAD",
				"HEAD",
				support,
			);
			expect(preflight.kind).toBe("unresolved");
			expect(conflictedPaths(preflight)).toEqual([]);
		} finally {
			await ws.cleanup();
		}
	}, 60_000);

	test("能力不可用时短路：连一个不存在的 ref 也只报 unsupported", async () => {
		// 若此处仍去跑 git，无效 ref 会把结论变成 unresolved；
		// 拿到 unsupported 就证明这一对根本没被送进 git。
		const ws = await makeTempWorkbench();
		try {
			await gitInit(ws);
			const preflight = await preflightPair(ws.projectDir, "no-1", "no-2", {
				kind: "unsupported",
				reason: "模拟：这个 git 不认识 --write-tree",
			});
			expect(preflight).toEqual({
				kind: "unsupported",
				reason: "模拟：这个 git 不认识 --write-tree",
			});
		} finally {
			await ws.cleanup();
		}
	}, 60_000);
});
