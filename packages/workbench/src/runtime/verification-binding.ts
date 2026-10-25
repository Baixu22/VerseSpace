import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	artifactSnapshotDifference,
	captureArtifactSnapshot,
} from "../artifacts/snapshot";
import type { Blackboard } from "../blackboard";
import { parseDurationSeconds } from "../duration";
import { type GitRunner, git } from "../git";
import type { Checkpoint, VerificationBinding } from "../types/checkpoint";
import {
	fixedObjectCurrentIssue,
	fixedObjectReportIssue,
} from "../verifier/fixed-object";
import type { RuntimeNotification } from "./types";
import { captureVerificationContext } from "./verification-context";

import {
	type BindingOptions,
	captureVerificationBinding,
	workbenchPrefixIn,
} from "./verification-snapshot";

export {
	captureVerificationBinding,
	workbenchPrefixIn,
} from "./verification-snapshot";

/** 该 checkpoint 的工作区路径；workspot 缺失时返回 null。相对路径按项目根解析。 */
export async function workspotWorktreePath(
	bb: Blackboard,
	workspotId: string,
): Promise<string | null> {
	const workspot = await bb.state.workspots.get(workspotId);
	if (!workspot) {
		return null;
	}
	return isAbsolute(workspot.worktreePath)
		? workspot.worktreePath
		: join(bb.projectRoot, workspot.worktreePath);
}

/** 在指定 worktree 上采集绑定（自动排除 workbench 状态目录）。 */
export async function captureBindingForWorktree(
	bb: Blackboard,
	worktreePath: string,
	reportPath?: string,
): Promise<VerificationBinding | undefined> {
	const prefix = workbenchPrefixIn(worktreePath, bb.paths.root);
	return (
		(await captureVerificationBinding(worktreePath, git, {
			ignorePrefixes: prefix ? [prefix] : [],
			ignorePaths: reportPath
				? [reportPath.replace(/\\/g, "/").replace(/^\.\//, "")]
				: [],
		})) ?? undefined
	);
}

/** 验证完成时采集绑定；不可读时返回 undefined，由调用方保留未知状态。 */
export async function captureBindingForCheckpoint(
	bb: Blackboard,
	checkpoint: Checkpoint,
): Promise<VerificationBinding | undefined> {
	const worktree = await workspotWorktreePath(bb, checkpoint.workspot);
	if (!worktree) {
		return undefined;
	}
	const context = await captureVerificationContext(
		checkpoint.verification,
		worktree,
		parseDurationSeconds(
			(await bb.config.load()).thresholds.checkpointTimeout,
		) ?? undefined,
		"human",
	);
	const binding = await captureBindingForWorktree(
		bb,
		worktree,
		checkpoint.verification?.evidence?.report.path,
	);
	return binding && context ? { ...binding, context } : undefined;
}

export type BindingVerdict =
	| { status: "unbound" }
	| { status: "intact" }
	| { status: "invalidated"; reason: string };

/**
 * 比较验证绑定与当前工作区：
 * - 无绑定 → unbound（不可比较，保持既有行为，不阻塞）；
 * - 现在读不到工作区 → 过期（无法证明仍成立，不静默当 intact）；
 * - HEAD 不同 → 过期（验证对象已经不是当前对象）;
 * - 绑定时的改动文件当前 hash 不同或不存在 → 过期；
 * - 绑定时干净而现在出现改动 → 过期。
 *
 * 只判「证据是否仍指向同一状态」，不判变化是否语义相关——保守方向是重验。
 */
export async function checkVerificationBinding(
	worktreePath: string,
	binding: VerificationBinding | undefined,
	runGit: GitRunner = git,
	options: BindingOptions = {},
): Promise<BindingVerdict> {
	if (!binding) {
		return { status: "unbound" };
	}
	const current = await captureVerificationBinding(
		worktreePath,
		runGit,
		options,
	);
	return compareVerificationBindings(binding, current);
}

/** Compare two captures without silently stamping a post-check change as tested. */
export function compareVerificationBindings(
	binding: VerificationBinding,
	current: VerificationBinding | null | undefined,
): Exclude<BindingVerdict, { status: "unbound" }> {
	if (!current) {
		return {
			status: "invalidated",
			reason: "验证记录存在，但当前工作区不可读，无法确认验证依据仍然成立",
		};
	}
	if (current.commit !== binding.commit) {
		return {
			status: "invalidated",
			reason: `验证时的 HEAD ${binding.commit.slice(0, 12)} 已不是当前 HEAD ${current.commit.slice(0, 12)}`,
		};
	}
	for (const [path, recorded] of Object.entries(binding.files)) {
		const now = current.files[path];
		if (now === recorded) continue;
		if (now === null) {
			return { status: "invalidated", reason: `验证后 ${path} 已被删除` };
		}
		if (now !== recorded) {
			return {
				status: "invalidated",
				reason: `验证后 ${path} 内容或存在状态已变化`,
			};
		}
	}
	for (const path of Object.keys(current.files)) {
		if (!(path in binding.files)) {
			return {
				status: "invalidated",
				reason: `验证后新增了未覆盖的改动：${path}`,
			};
		}
	}
	return { status: "intact" };
}

/**
 * 一个 verified 区 checkpoint 现在能否推进 applied。返回过期原因，否则 null
 * （未绑定或仍成立）。工作区缺失时按过期处理，不凭记录放行。
 */
export async function verificationStalenessReason(
	bb: Blackboard,
	checkpoint: Checkpoint,
	runGit: GitRunner = git,
): Promise<string | null> {
	if (checkpoint.verificationBindingIssue) {
		return checkpoint.verificationBindingIssue;
	}
	if (!checkpoint.verificationBinding) {
		return null;
	}
	const worktree = await workspotWorktreePath(bb, checkpoint.workspot);
	if (!worktree) {
		return `找不到 worktree ${checkpoint.workspot}，无法确认验证依据仍然成立`;
	}
	if (checkpoint.verificationBinding.context) {
		const recorded = checkpoint.verificationBinding.context;
		const current = await captureVerificationContext(
			checkpoint.verification,
			worktree,
			parseDurationSeconds(
				(await bb.config.load()).thresholds.checkpointTimeout,
			) ?? undefined,
			recorded.authority,
		);
		if (!current) return "当前执行目录不可读，无法确认验证执行条件";
		if (!isDeepStrictEqual(recorded, current))
			return "验证执行条件已变化（目录、命令、预期退出码、超时、声明范围或配置/运行时），需要重新验证";
	}
	if (checkpoint.artifact) {
		if (checkpoint.verification?.evidence?.fixedFiles) {
			const object = checkpoint.verificationResult?.object;
			if (!object) return "固定副本检查缺少执行对象";
			if (
				object.reportHash !==
					checkpoint.verificationResult?.evidence?.reportHash ||
				!isDeepStrictEqual(
					object.runner,
					checkpoint.verificationBinding.context?.fixedRunner,
				)
			)
				return "固定副本报告或实际运行器与检查记录不一致";
			const issue =
				(await fixedObjectCurrentIssue(object, worktree, {
					artifact: checkpoint.artifact,
					verification: checkpoint.verification,
				})) ??
				(await fixedObjectReportIssue(
					object,
					join(bb.paths.checkpoints, "objects"),
				));
			if (issue) return issue;
		}
		return checkpoint.artifactBinding
			? artifactSnapshotDifference(
					checkpoint.artifactBinding,
					await captureArtifactSnapshot(bb, checkpoint),
				)
			: "产物验证缺少输入/工位身份绑定";
	}
	const prefix = workbenchPrefixIn(worktree, bb.paths.root);
	const verdict = await checkVerificationBinding(
		worktree,
		checkpoint.verificationBinding,
		runGit,
		{
			ignorePrefixes: prefix ? [prefix] : [],
			ignorePaths: checkpoint.verification?.evidence
				? [
						checkpoint.verification.evidence.report.path
							.replace(/\\/g, "/")
							.replace(/^\.\//, ""),
					]
				: [],
		},
	);
	return verdict.status === "invalidated" ? verdict.reason : null;
}

/**
 * 退回重验：verified → staging（lifecycle 回到 draft，附失效读数与事件）。
 * 下一轮 automaton 会重新 request_verification；目标不会完成，因为没有 applied。
 */
export async function invalidateVerification(
	bb: Blackboard,
	checkpoint: Checkpoint,
	reason: string,
	notifications: RuntimeNotification[],
): Promise<void> {
	const at = new Date().toISOString();
	// 先把附了失效读数的版本写回 verified 区，再 move——move 读取的是 from 区的
	// 文件内容，直接 save 到 staging 会被随后的 move 覆盖（verifyCheckpoint 里
	// 的 save-then-move 方向相反，所以那边没有这个问题）。
	await bb.checkpoints.save(
		{
			...checkpoint,
			lifecycle: "draft",
			verificationInvalidatedAt: at,
			verificationInvalidatedReason: reason,
		},
		"verified",
	);
	await bb.checkpoints.move(checkpoint.id, "verified", "staging");
	await bb.events.append({
		timestamp: at,
		source: "runtime",
		type: "verification_invalidated",
		payload: { cpId: checkpoint.id, reason, worktree: checkpoint.workspot },
	});
	notifications.push({
		severity: "warning",
		message:
			`checkpoint ${checkpoint.id} 的验证已过期：${reason}；` +
			"已退回 staging 重新验证，不会在旧绿灯下推进。",
	});
}
