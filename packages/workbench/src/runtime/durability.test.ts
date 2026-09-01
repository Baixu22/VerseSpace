import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { makeTempWorkbench } from "../test/fixtures";
import { tierOf } from "./durability";
import { reconcilePremises } from "./premises";

/**
 * R2 谓词第 1 层（TF-0074）：读集来源分级。这是三层里唯一"纯精度收益、
 * 零召回损失"的一层——durable 的内容本来就能从源码重建，它变了不可能推翻
 * 任何人的前提。下面最后两个用例就是这层的验收标准。
 */
describe("durability tiers（R2 谓词第 1 层）", () => {
	test("依赖树与生成物是 durable，源码是 volatile", () => {
		expect(tierOf("node_modules/left-pad/index.js")).toBe("durable");
		expect(tierOf("packages/app/node_modules/left-pad/index.js")).toBe(
			"durable",
		);
		expect(tierOf("internal/vendor/strconv.go")).toBe("durable");
		expect(tierOf("app/dist/main.js")).toBe("durable");
		expect(tierOf("app/build/output.js")).toBe("durable");
		expect(tierOf("app/out/bundle.js")).toBe("durable");
		expect(tierOf("app/coverage/lcov.info")).toBe("durable");
		expect(tierOf("repo/.git/config")).toBe("durable");
		expect(tierOf("crate/target/debug/deps/libr.rlib")).toBe("durable");
		expect(tierOf("pkg/__pycache__/mod.cpython-313.pyc")).toBe("durable");
		expect(tierOf("proj/.workbench/state/queue.yaml")).toBe("durable");

		expect(tierOf("src/runtime/premises.ts")).toBe("volatile");
		expect(tierOf("packages/workbench/src/index.ts")).toBe("volatile");
		expect(tierOf("README.md")).toBe("volatile");
	});

	test("生成物后缀单独判 durable（与所在目录无关）", () => {
		expect(tierOf("public/app.min.js")).toBe("durable");
		expect(tierOf("public/app.min.css")).toBe("durable");
		expect(tierOf("public/app.js.map")).toBe("durable");
		expect(tierOf("bun.lockb")).toBe("durable");
		// 同名但非生成物的源码不受影响
		expect(tierOf("public/app.js")).toBe("volatile");
	});

	test("Windows 反斜杠路径按同一套规则分级", () => {
		expect(tierOf("src\\runtime\\premises.ts")).toBe("volatile");
		expect(tierOf("node_modules\\left-pad\\index.js")).toBe("durable");
		expect(tierOf("D:\\repo\\node_modules\\x\\index.js")).toBe("durable");
		expect(tierOf("dist\\app.js")).toBe("durable");
	});

	test("仓库根部的可复现目录同样判 durable（相对路径不再漏网）", () => {
		expect(tierOf("dist/app.js")).toBe("durable");
		expect(tierOf("build/output.js")).toBe("durable");
		expect(tierOf("out/bundle.js")).toBe("durable");
		expect(tierOf("coverage/lcov.info")).toBe("durable");
		expect(tierOf(".git/config")).toBe("durable");
		expect(tierOf(".workbench/workbench.yaml")).toBe("durable");
		expect(tierOf("target/debug/app")).toBe("durable");
		expect(tierOf("vendor/strconv.go")).toBe("durable");
		expect(tierOf("__pycache__/mod.pyc")).toBe("durable");
		expect(tierOf("node_modules/x/index.js")).toBe("durable");

		// 放宽的边界：只认目录边界，不能把同前缀的源码吞进去
		expect(tierOf("package.json")).toBe("volatile");
		expect(tierOf("src/app.ts")).toBe("volatile");
		expect(tierOf("outbox.ts")).toBe("volatile");
		expect(tierOf("builder.ts")).toBe("volatile");
		expect(tierOf("targets.json")).toBe("volatile");
		expect(tierOf("vendors.md")).toBe("volatile");
	});

	test("hashPathClaim 给每个声明打上 tier，且 durable 不落 spool", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "node_modules", "x"), {
				recursive: true,
			});
			await writeFile(
				join(ws.projectDir, "node_modules", "x", "index.js"),
				"module.exports = 1;",
				"utf8",
			);
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(
				join(ws.projectDir, "src", "app.ts"),
				"export const a = 1;",
				"utf8",
			);
			const spoolDir = join(ws.workbenchRoot, "sessions", "w", "spool");

			const durable = await hashPathClaim(
				ws.projectDir,
				"node_modules/x/index.js",
				spoolDir,
			);
			expect(durable.durability).toBe("durable");
			expect(durable.spool).toBeUndefined(); // 生成物不值得留快照

			const volatile = await hashPathClaim(
				ws.projectDir,
				"src/app.ts",
				spoolDir,
			);
			expect(volatile.durability).toBe("volatile");
			expect(volatile.version).toBeTruthy();
			expect(volatile.spool).toBeTruthy(); // 只有 volatile 读参与 diff
		} finally {
			await ws.cleanup();
		}
	});

	// ---- 以下是 TF-0074 的验收标准 ----

	test("两个文件都被改过，只有源码那条进通知，node_modules 完全静默", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "node_modules", "x"), {
				recursive: true,
			});
			await mkdir(join(ws.projectDir, "src"), { recursive: true });
			await writeFile(
				join(ws.projectDir, "node_modules", "x", "index.js"),
				"module.exports = 1;",
				"utf8",
			);
			await writeFile(
				join(ws.projectDir, "src", "app.ts"),
				"export const a = 1;",
				"utf8",
			);

			await ws.bb.sessions.register("agent-a", "agent", "A");
			await ws.bb.sessions.recordActivity("agent-a", {
				activity: "act-1",
				agent: "agent-a",
				used: [
					{ path: "src/app.ts", version: "stale", durability: "volatile" },
					{
						path: "node_modules/x/index.js",
						version: "stale",
						durability: "durable",
					},
				],
				generated: [],
			});

			// 别人的提交把两个文件都动了
			await writeFile(
				join(ws.projectDir, "node_modules", "x", "index.js"),
				"module.exports = 2;",
				"utf8",
			);
			await writeFile(
				join(ws.projectDir, "src", "app.ts"),
				"export const a = 2;",
				"utf8",
			);

			const delivered: string[] = [];
			const notices = await reconcilePremises(ws.bb, {
				deliver: async (notice) => {
					delivered.push(notice.writerId);
					return "delivered";
				},
			});

			expect(notices).toHaveLength(1);
			expect(notices[0]!.writerId).toBe("agent-a");
			expect(notices[0]!.stale.map((claim) => claim.path)).toEqual([
				"src/app.ts",
			]);
			expect(delivered).toEqual(["agent-a"]);
		} finally {
			await ws.cleanup();
		}
	});

	test("只碰过 node_modules 的写者一条通知都拿不到", async () => {
		const ws = await makeTempWorkbench();
		try {
			await mkdir(join(ws.projectDir, "node_modules", "x"), {
				recursive: true,
			});
			await writeFile(
				join(ws.projectDir, "node_modules", "x", "index.js"),
				"module.exports = 1;",
				"utf8",
			);
			await ws.bb.sessions.register("agent-b", "agent", "B");
			await ws.bb.sessions.recordActivity("agent-b", {
				activity: "act-1",
				agent: "agent-b",
				used: [
					{
						path: "node_modules/x/index.js",
						version: "stale",
						durability: "durable",
					},
				],
				generated: [],
			});
			await writeFile(
				join(ws.projectDir, "node_modules", "x", "index.js"),
				"module.exports = 2;",
				"utf8",
			);

			const notices = await reconcilePremises(ws.bb);
			expect(notices).toHaveLength(0);
			const events = await ws.bb.events.query({ type: "premise_stale" });
			expect(events).toHaveLength(0);
		} finally {
			await ws.cleanup();
		}
	});
});
