import { describe, expect, test } from "bun:test";
import type { Command } from "commander";
import { hashPathClaim } from "../blackboard/footprint";
import { reconcilePremises } from "../runtime/premises";
import { makeTempWorkbench } from "../test/fixtures";
import { sessionsRecordCommand } from "./sessions";

/**
 * TF-0150：git 作为写者。写者中立在此之前只是口号——黑板早就接受
 * `kind: "git"`，但没有任何非 TypeScript 调用方能够到达它。
 */

type Workbench = Awaited<ReturnType<typeof makeTempWorkbench>>;

/** Minimal Command stand-in: the command only reads the global options. */
function cmd(globals: { json?: boolean; quiet?: boolean } = {}): Command {
	return {
		optsWithGlobals: () => ({ quiet: true, ...globals }),
	} as unknown as Command;
}

/** Run a command with cwd inside the workspace, the way the CLI would. */
async function inWorkspace<T>(
	ws: Workbench,
	body: () => Promise<T>,
): Promise<T> {
	const previous = process.cwd();
	try {
		process.chdir(ws.projectDir);
		return await body();
	} finally {
		process.chdir(previous);
	}
}

async function writeSource(
	ws: Workbench,
	relative: string,
	body: string,
): Promise<void> {
	await Bun.write(`${ws.projectDir}/${relative}`, body);
}

describe("workbench sessions record（TF-0150 验收一、四）", () => {
	test("默认就是 git 写者：注册 + 一轮足迹，list 里以 kind=git 出现", async () => {
		const ws = await makeTempWorkbench();
		try {
			await writeSource(ws, "src/a.ts", "export const a = 1;\n");
			await inWorkspace(ws, () =>
				sessionsRecordCommand(
					{ activity: "post-merge", generated: ["src/a.ts"] },
					cmd(),
				),
			);

			const writers = await ws.bb.sessions.list();
			const git = writers.find((writer) => writer.id === "git");
			expect(git?.kind).toBe("git");

			const { writes } = await ws.bb.sessions.readSetView("git");
			expect(writes.map((write) => write.path)).toEqual(["src/a.ts"]);
			// 写入被哈希：前提比对靠的就是这个版本号
			expect(writes[0]?.version).toBeTruthy();
		} finally {
			await ws.cleanup();
		}
	});

	test("路径也可以从 stdin 来（git diff --name-only | workbench …）", async () => {
		const ws = await makeTempWorkbench();
		try {
			await writeSource(ws, "src/a.ts", "export const a = 1;\n");
			await writeSource(ws, "src/b.ts", "export const b = 1;\n");
			const original = process.stdin;
			// 逐行喂进去，顺便证明空行与 \r 都被清掉
			const fake = (async function* () {
				yield "src/a.ts\r\n\nsrc/b.ts\n";
			})();
			Object.defineProperty(process, "stdin", {
				value: Object.assign(fake, { isTTY: false }),
				configurable: true,
			});
			try {
				await inWorkspace(ws, () =>
					sessionsRecordCommand({ activity: "post-checkout" }, cmd()),
				);
			} finally {
				Object.defineProperty(process, "stdin", {
					value: original,
					configurable: true,
				});
			}

			const { writes } = await ws.bb.sessions.readSetView("git");
			expect(writes.map((write) => write.path).sort()).toEqual([
				"src/a.ts",
				"src/b.ts",
			]);
		} finally {
			await ws.cleanup();
		}
	});

	test("什么都没变时不记账：空一轮会污染写者的时钟", async () => {
		const ws = await makeTempWorkbench();
		try {
			await inWorkspace(ws, () =>
				sessionsRecordCommand({ activity: "post-merge", generated: [] }, cmd()),
			);
			expect(await ws.bb.sessions.get("git")).toBeNull();
			expect(await ws.bb.events.query({ type: "footprint" })).toHaveLength(0);
		} finally {
			await ws.cleanup();
		}
	});

	test("黑板自己的文件不算世界的变化：.workbench/ 一律剔掉", async () => {
		const ws = await makeTempWorkbench();
		try {
			await writeSource(ws, "src/a.ts", "export const a = 1;\n");
			await inWorkspace(ws, () =>
				sessionsRecordCommand(
					{
						activity: "post-merge",
						generated: [
							".workbench/events/events.jsonl",
							".workbench/workbench.yaml",
							"src/a.ts",
						],
					},
					cmd(),
				),
			);
			const { writes } = await ws.bb.sessions.readSetView("git");
			expect(writes.map((write) => write.path)).toEqual(["src/a.ts"]);
		} finally {
			await ws.cleanup();
		}
	});

	test("整轮都是黑板自己的文件时，退化成不记账", async () => {
		const ws = await makeTempWorkbench();
		try {
			await inWorkspace(ws, () =>
				sessionsRecordCommand(
					{
						activity: "post-merge",
						generated: [".workbench/events/events.jsonl"],
					},
					cmd(),
				),
			);
			expect(await ws.bb.sessions.get("git")).toBeNull();
		} finally {
			await ws.cleanup();
		}
	});

	test("--kind 可以记别的写者，未知类型直接报错", async () => {
		const ws = await makeTempWorkbench();
		try {
			await writeSource(ws, "src/a.ts", "export const a = 1;\n");
			await inWorkspace(ws, () =>
				sessionsRecordCommand(
					{ writer: "ci-1", kind: "ci", generated: ["src/a.ts"] },
					cmd(),
				),
			);
			expect((await ws.bb.sessions.get("ci-1"))?.kind).toBe("ci");

			await inWorkspace(ws, async () => {
				await expect(
					sessionsRecordCommand(
						{ writer: "x", kind: "robot", generated: ["src/a.ts"] },
						cmd(),
					),
				).rejects.toThrow("未知写者类型");
			});
		} finally {
			await ws.cleanup();
		}
	});

	test("没有 .workbench 的仓库里静默返回：hook 装了就到处跑", async () => {
		const bare = `${process.env.TEMP ?? "/tmp"}/wb-record-bare-${Date.now()}`;
		await Bun.write(`${bare}/README.md`, "# bare\n");
		const previous = process.cwd();
		try {
			process.chdir(bare);
			// 不抛：hook 在任意仓库里都会被 git 调用
			await sessionsRecordCommand({ generated: ["README.md"] }, cmd());
		} finally {
			process.chdir(previous);
			await Bun.$`rm -rf ${bare}`.quiet().nothrow();
		}
	});
});

describe("git 改动让 agent 收到通知（TF-0150 验收三）", () => {
	test("git 登记了写入之后，读过那个文件的 agent 拿到 premise_notice", async () => {
		const ws = await makeTempWorkbench();
		try {
			await writeSource(ws, "src/shared.ts", "export const v = 1;\n");
			// 一个正在跑的 agent 读过这个文件
			const claim = await hashPathClaim(ws.projectDir, "src/shared.ts");
			await ws.bb.sessions.register("agent-1", "agent", "A");
			await ws.bb.sessions.recordActivity("agent-1", {
				activity: "a1",
				agent: "agent-1",
				used: [claim],
				generated: [],
			});

			// git pull：文件在 agent 脚下变了，hook 把它登记给 git 写者
			await writeSource(ws, "src/shared.ts", "export const v = 2;\n");
			await inWorkspace(ws, () =>
				sessionsRecordCommand(
					{ activity: "post-merge", generated: ["src/shared.ts"] },
					cmd(),
				),
			);

			const notices = await reconcilePremises(ws.bb);
			expect(notices).toHaveLength(1);
			expect(notices[0]!.writerId).toBe("agent-1");
			expect(notices[0]!.stale.map((s) => s.path)).toEqual(["src/shared.ts"]);

			// 推定写者是 git：30 天护城河要的就是这条非 agent 的通知
			const byGit = await ws.bb.sessions.recentGeneratedPaths(60_000, "git");
			expect(byGit.has("src/shared.ts")).toBe(true);
		} finally {
			await ws.cleanup();
		}
	});

	test("归因过滤器同时排除 agent 与 git 的声明", async () => {
		const ws = await makeTempWorkbench();
		try {
			await writeSource(ws, "src/a.ts", "export const a = 1;\n");
			await writeSource(ws, "src/b.ts", "export const b = 1;\n");
			await ws.bb.sessions.register("agent-1", "agent", "A");
			await ws.bb.sessions.recordActivity("agent-1", {
				activity: "a1",
				agent: "agent-1",
				used: [],
				generated: [await hashPathClaim(ws.projectDir, "src/a.ts")],
			});
			await inWorkspace(ws, () =>
				sessionsRecordCommand(
					{ activity: "post-merge", generated: ["src/b.ts"] },
					cmd(),
				),
			);

			// 只问 agent：git 那条不在里面（这是修改前 watcher 的行为）
			const agentOnly = await ws.bb.sessions.recentGeneratedPaths(60_000);
			expect([...agentOnly].sort()).toEqual(["src/a.ts"]);

			// 两类一起问：watcher 现在用的就是这个，git pull 的文件不再算人改的
			const both = await ws.bb.sessions.recentGeneratedPaths(60_000, [
				"agent",
				"git",
			]);
			expect([...both].sort()).toEqual(["src/a.ts", "src/b.ts"]);
		} finally {
			await ws.cleanup();
		}
	});
});
