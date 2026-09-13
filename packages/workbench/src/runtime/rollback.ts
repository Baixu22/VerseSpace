/**
 * 回退 + diff 主安全网（TF-0098）。
 *
 * 廉价可逆是 ADR-0009 的替代品：提议区间为空，所以系统永远「直接做」，
 * 代价是回退必须真便宜、真可靠。三个动作必须是三个有明确标签的不同动作
 * （Cursor 最持久的投诉就是 Restore Checkpoint 语义含糊）。
 *
 * 两个面分开处理，因为它们是不同动作的对象：
 *  - code：git 支撑，用 checkpoint 采集时的 HEAD 还原改动文件；
 *  - context：blackboard 键值，用采集时的旧值写回（null = 原本不存在）。
 *
 * 没有快照就明确拒绝，不假装回退。
 */

import { join } from "node:path";
import { git } from "../git";
import { hashFile } from "../hash";
import {
	type Checkpoint,
	type Rollback,
	type RollbackScope,
	SCOPE_LABELS,
} from "../types/checkpoint";

/** 上下文面的读写接口（由命令层用 blackboard 实现，保持本模块可测）。 */
export interface ContextStore {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown): Promise<void>;
	remove(key: string): Promise<void>;
}

export interface CodeDiffEntry {
	path: string;
	/** 采集时记录的内容 hash。 */
	recorded: string;
	/** 当前内容 hash；null = 文件已不存在。 */
	current: string | null;
	changed: boolean;
}

export interface ContextDiffEntry {
	key: string;
	/** 采集时记录的旧值（null = 原本不存在）。 */
	before: unknown;
	current: unknown;
	changed: boolean;
}

export interface RollbackPlan {
	checkpointId: string;
	scope: RollbackScope;
	label: string;
	code: CodeDiffEntry[];
	context: ContextDiffEntry[];
	/** 需要变更的项数；0 = 无需回退。 */
	pending: number;
	/** 缺快照等拒绝原因；非空时调用方不得执行。 */
	error?: string;
}

/**
 * 采集代码面快照：HEAD commit + 所有被改动文件的当前内容 hash。
 * 这是回退的恢复点——没有它，代码回退无从谈起。
 */
export async function captureCodeRollback(
	worktreePath: string,
): Promise<NonNullable<Rollback["code"]>> {
	const head = await git(["rev-parse", "HEAD"], worktreePath);
	if (!head.ok) {
		// 工作区不可读（如 worktree 还没被 dispatch 建立）时必须抛错：
		// 空 commit 会绕过调用方的 catch，最后被 checkpoint schema 以裸
		// zod JSON 拒绝（issue #1，2026-09-13）。抛错让调用方按
		// 「不可读不阻塞」的既有约定降级为无恢复点 checkpoint。
		throw new Error(
			`无法读取工作区 HEAD（${worktreePath}）：${head.stderr.trim() || "git rev-parse 失败"}`,
		);
	}
	const commit = head.stdout.trim();
	const status = await git(["status", "--porcelain"], worktreePath);
	const paths: string[] = [];
	const hashes: Record<string, string> = {};
	for (const line of status.stdout.split("\n")) {
		if (!line.trim()) {
			continue;
		}
		// porcelain 格式：`XY <path>`；重命名时为 `XY old -> new`，取后者
		const p = line.slice(3).trim().split(" -> ").pop();
		if (p) {
			paths.push(p);
		}
	}
	for (const p of paths) {
		try {
			hashes[p] = await hashFile(join(worktreePath, p));
		} catch {
			// 被删除的文件（porcelain 里的 D）无内容可哈希，留空
		}
	}
	return { commit, paths, hashes };
}

/**
 * 采集上下文面快照：effects 将要改动的键，在改动前的值。
 * 必须在 effects 应用**之前**调用——这是回退的唯一依据。
 * 键原本不存在时记 null（回退时删除）。
 */
export async function captureContextRollback(
	store: ContextStore,
	keys: string[],
): Promise<Record<string, unknown>> {
	const before: Record<string, unknown> = {};
	for (const key of keys) {
		before[key] = (await store.get(key)) ?? null;
	}
	return before;
}

function hasCode(rollback: Rollback | undefined): boolean {
	return Boolean(rollback?.code?.commit);
}

function hasContext(rollback: Rollback | undefined): boolean {
	return Boolean(rollback?.context && Object.keys(rollback.context).length > 0);
}

/** 生成回退计划（含 diff，不改动任何东西）。 */
export async function planRollback(
	checkpoint: Checkpoint,
	scope: RollbackScope,
	options: { worktreePath?: string; store?: ContextStore } = {},
): Promise<RollbackPlan> {
	const plan: RollbackPlan = {
		checkpointId: checkpoint.id,
		scope,
		label: SCOPE_LABELS[scope],
		code: [],
		context: [],
		pending: 0,
	};

	const wantsCode = scope === "code" || scope === "both";
	const wantsContext = scope === "context" || scope === "both";

	if (wantsCode) {
		if (!hasCode(checkpoint.rollback)) {
			plan.error = `checkpoint ${checkpoint.id} 没有代码回退快照（无 HEAD 记录），无法${SCOPE_LABELS[scope]}`;
			return plan;
		}
		if (!options.worktreePath) {
			plan.error = `checkpoint ${checkpoint.id} 的工作区路径不可用，无法恢复代码`;
			return plan;
		}
		const snap = checkpoint.rollback?.code;
		for (const path of snap?.paths ?? []) {
			let current: string | null = null;
			try {
				current = await hashFile(join(options.worktreePath, path));
			} catch {
				current = null;
			}
			const recorded = snap?.hashes[path] ?? "";
			plan.code.push({
				path,
				recorded,
				current,
				changed: current !== recorded,
			});
		}
	}

	if (wantsContext) {
		if (!hasContext(checkpoint.rollback)) {
			plan.error = `checkpoint ${checkpoint.id} 没有上下文回退快照，无法${SCOPE_LABELS[scope]}`;
			return plan;
		}
		const store = options.store;
		if (!store) {
			plan.error = `checkpoint ${checkpoint.id} 的上下文存储不可用，无法恢复上下文`;
			return plan;
		}
		for (const [key, before] of Object.entries(
			checkpoint.rollback?.context ?? {},
		)) {
			const current = await store.get(key);
			plan.context.push({
				key,
				before,
				current,
				changed: JSON.stringify(current) !== JSON.stringify(before),
			});
		}
	}

	plan.pending =
		plan.code.filter((e) => e.changed).length +
		plan.context.filter((e) => e.changed).length;
	return plan;
}

export interface RollbackResult {
	ok: boolean;
	code: string[];
	context: string[];
	reason?: string;
}

/** 执行回退。计划含 error 或无可变更项时不做任何事。 */
export async function applyRollback(
	plan: RollbackPlan,
	checkpoint: Checkpoint,
	options: { worktreePath?: string; store?: ContextStore } = {},
): Promise<RollbackResult> {
	if (plan.error) {
		return { ok: false, code: [], context: [], reason: plan.error };
	}
	const result: RollbackResult = { ok: true, code: [], context: [] };

	// 代码面：用采集时的 HEAD 还原有变化的文件
	const codePaths = plan.code.filter((e) => e.changed).map((e) => e.path);
	if (codePaths.length > 0) {
		const snap = checkpoint.rollback?.code;
		const worktreePath = options.worktreePath;
		if (!snap?.commit || !worktreePath) {
			return {
				...result,
				ok: false,
				reason: "缺少代码快照（commit 或工作区路径），拒绝回退",
			};
		}
		const res = await git(
			["checkout", snap.commit, "--", ...codePaths],
			worktreePath,
		);
		if (!res.ok) {
			return {
				...result,
				ok: false,
				reason: `git checkout 失败：${res.stderr.trim() || "未知原因"}`,
			};
		}
		result.code = codePaths;
	}

	// 上下文面：把旧值写回（null = 原本不存在 → 删除）
	const store = options.store;
	for (const entry of plan.context.filter((e) => e.changed)) {
		if (!store) {
			return { ...result, ok: false, reason: "缺少上下文存储，拒绝回退" };
		}
		if (entry.before === null || entry.before === undefined) {
			await store.remove(entry.key);
		} else {
			await store.set(entry.key, entry.before);
		}
		result.context.push(entry.key);
	}

	return result;
}
