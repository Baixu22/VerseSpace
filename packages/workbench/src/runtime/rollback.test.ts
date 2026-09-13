/**
 * 回退 + diff 主安全网测试（TF-0098）：
 *  - 采集代码面快照（HEAD + 改动文件 hash）
 *  - 回退计划：diff 正确、无快照时明确拒绝
 *  - 三个动作语义区分（code / context / both 各自动什么）
 *  - 执行后文件与上下文真的恢复；撤销留痕由调用方记录
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint } from "../types/checkpoint";
import {
	applyRollback,
	type ContextStore,
	captureCodeRollback,
	captureContextRollback,
	planRollback,
} from "./rollback";

const tempRoots: string[] = [];

function git(root: string, args: string[]): void {
	execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

/** 建一个带一次提交的临时仓库，返回根路径。 */
function makeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), "rollback-repo-"));
	tempRoots.push(root);
	git(root, ["init", "-q", "-b", "main"]);
	git(root, ["config", "user.email", "t@example.com"]);
	git(root, ["config", "user.name", "test"]);
	// Windows 默认会把 LF 转成 CRLF，导致 checkout 回来的内容与写入的不一致
	git(root, ["config", "core.autocrlf", "false"]);
	writeFileSync(join(root, "a.txt"), "v1\n");
	writeFileSync(join(root, "b.txt"), "b1\n");
	git(root, ["add", "."]);
	git(root, ["commit", "-q", "-m", "init"]);
	return root;
}

function memoryStore(initial: Record<string, unknown> = {}): ContextStore & {
	data: Record<string, unknown>;
} {
	return {
		data: { ...initial },
		async get(key: string) {
			return this.data[key] ?? null;
		},
		async set(key: string, value: unknown) {
			this.data[key] = value;
		},
		async remove(key: string) {
			delete this.data[key];
		},
	};
}

function cpWith(checkpoint: Partial<Checkpoint> = {}): Checkpoint {
	return {
		id: "cp-test",
		goal: "g1",
		workspot: "ws1",
		timestamp: new Date().toISOString(),
		lifecycle: "applied",
		assertion: "测试断言",
		artifacts: [],
		unblocks: [],
		...checkpoint,
	};
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const root = tempRoots.pop();
		if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	}
});

describe("captureCodeRollback", () => {
	test("记录 HEAD 与改动文件的 hash", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "a.txt"), "v2\n"); // 改动未提交
		const snap = await captureCodeRollback(root);
		expect(snap.commit).toMatch(/^[0-9a-f]{7,40}$/);
		expect(snap.paths).toContain("a.txt");
		expect(snap.hashes["a.txt"]).toBeDefined();
	});

	test("干净工作区没有改动文件", async () => {
		const root = makeRepo();
		const snap = await captureCodeRollback(root);
		expect(snap.paths).toHaveLength(0);
		expect(snap.commit.length).toBeGreaterThan(0);
	});

	test("worktree 缺失时抛错，绝不返回空 commit（issue #1）", async () => {
		// ws create 只登记 workspot 不建 worktree（dispatch 才建）。
		// 曾经这里返回 commit: ""，一路传进 schema 才以裸 zod JSON 拒绝；
		// 现在必须在此处抛错，由 checkpointCreate 的 catch 降级为无恢复点。
		const missing = join(tmpdir(), `rollback-missing-${Date.now()}`);
		await expect(captureCodeRollback(missing)).rejects.toThrow(
			/无法读取工作区 HEAD/,
		);
	});
});

describe("planRollback", () => {
	test("文件变化后 diff 标记 changed", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "a.txt"), "v2\n");
		const snap = await captureCodeRollback(root);
		writeFileSync(join(root, "a.txt"), "v3\n"); // 采集后再次改动
		const cp = cpWith({ rollback: { code: snap } });
		const plan = await planRollback(cp, "code", { worktreePath: root });
		expect(plan.error).toBeUndefined();
		expect(plan.code[0]?.changed).toBe(true);
		expect(plan.pending).toBe(1);
	});

	test("未改动时 pending 为 0", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "a.txt"), "v2\n");
		const snap = await captureCodeRollback(root);
		const cp = cpWith({ rollback: { code: snap } });
		const plan = await planRollback(cp, "code", { worktreePath: root });
		expect(plan.pending).toBe(0);
		expect(plan.code[0]?.changed).toBe(false);
	});

	test("没有回退快照时明确拒绝，不假装成功", async () => {
		const root = makeRepo();
		const cp = cpWith(); // 无 rollback
		const plan = await planRollback(cp, "code", { worktreePath: root });
		expect(plan.error).toContain("没有代码回退快照");
		const ctxPlan = await planRollback(cp, "context", {
			store: memoryStore(),
		});
		expect(ctxPlan.error).toContain("没有上下文回退快照");
	});

	test("三个动作只计算各自那一面", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "a.txt"), "v2\n");
		const snap = await captureCodeRollback(root);
		const cp = cpWith({
			rollback: { code: snap, context: { "k:1": "old" } },
		});
		const store = memoryStore({ "k:1": "new" });

		const codePlan = await planRollback(cp, "code", {
			worktreePath: root,
			store,
		});
		expect(codePlan.code.length).toBeGreaterThan(0);
		expect(codePlan.context).toHaveLength(0);

		const ctxPlan = await planRollback(cp, "context", {
			worktreePath: root,
			store,
		});
		expect(ctxPlan.context).toHaveLength(1);
		expect(ctxPlan.code).toHaveLength(0);
		expect(ctxPlan.context[0]?.changed).toBe(true);

		const bothPlan = await planRollback(cp, "both", {
			worktreePath: root,
			store,
		});
		expect(bothPlan.code.length).toBeGreaterThan(0);
		expect(bothPlan.context.length).toBeGreaterThan(0);
	});
});

describe("applyRollback", () => {
	test("代码回退把文件还原到采集时的 HEAD 基线", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "a.txt"), "v2\n");
		const snap = await captureCodeRollback(root);
		writeFileSync(join(root, "a.txt"), "v3\n");
		const cp = cpWith({ rollback: { code: snap } });

		const plan = await planRollback(cp, "code", { worktreePath: root });
		const result = await applyRollback(plan, cp, { worktreePath: root });
		expect(result.ok).toBe(true);
		expect(result.code).toContain("a.txt");
		// 恢复到 HEAD 基线（v1），不是采集时的 v2——恢复点是提交级
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v1\n");
	});

	test("dry-run 不做任何改动", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "a.txt"), "v2\n");
		const snap = await captureCodeRollback(root);
		writeFileSync(join(root, "a.txt"), "v3\n");
		const cp = cpWith({ rollback: { code: snap } });
		await planRollback(cp, "code", { worktreePath: root }); // 只计划不执行
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v3\n");
	});

	test("上下文回退写回旧值", async () => {
		const store = memoryStore({ "k:1": "new" });
		const cp = cpWith({ rollback: { context: { "k:1": "old" } } });
		const plan = await planRollback(cp, "context", { store });
		const result = await applyRollback(plan, cp, { store });
		expect(result.ok).toBe(true);
		expect(result.context).toEqual(["k:1"]);
		expect(store.data["k:1"]).toBe("old");
	});

	test("both 同时回退代码与上下文", async () => {
		const root = makeRepo();
		writeFileSync(join(root, "a.txt"), "v2\n");
		const snap = await captureCodeRollback(root);
		writeFileSync(join(root, "a.txt"), "v3\n");
		const store = memoryStore({ "k:1": "new" });
		const cp = cpWith({ rollback: { code: snap, context: { "k:1": "old" } } });

		const plan = await planRollback(cp, "both", {
			worktreePath: root,
			store,
		});
		const result = await applyRollback(plan, cp, {
			worktreePath: root,
			store,
		});
		expect(result.code).toContain("a.txt");
		expect(store.data["k:1"]).toBe("old");
	});

	test("计划含错误时拒绝执行", async () => {
		const root = makeRepo();
		const cp = cpWith();
		const plan = await planRollback(cp, "code", { worktreePath: root });
		const result = await applyRollback(plan, cp, { worktreePath: root });
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("没有代码回退快照");
	});
});

describe("captureContextRollback", () => {
	test("记录改动前的旧值，不存在的键记 null", async () => {
		const store = memoryStore({ "k:1": "v1" });
		const before = await captureContextRollback(store, ["k:1", "k:missing"]);
		expect(before["k:1"]).toBe("v1");
		expect(before["k:missing"]).toBeNull();
	});

	test("在改动前采集，回退能还原", async () => {
		const store = memoryStore({ "k:1": "v1" });
		const before = await captureContextRollback(store, ["k:1"]);
		await store.set("k:1", "v2"); // effect 生效
		const cp = cpWith({ rollback: { context: before } });
		const plan = await planRollback(cp, "context", { store });
		await applyRollback(plan, cp, { store });
		expect(store.data["k:1"]).toBe("v1");
	});
});
