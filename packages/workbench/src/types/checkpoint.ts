import { z } from "zod";
import {
	artifactDeclarationSchema,
	artifactInputOriginSchema,
	artifactSnapshotSchema,
} from "./artifact-evidence";
import { verificationStrategySchema } from "./goal";
import {
	verificationEvidenceSchema,
	verificationEvidenceSpecSchema,
	verificationObjectSchema,
} from "./verification-evidence";

export const CHECKPOINT_LIFECYCLES = [
	"draft",
	"pending",
	"verified",
	"applied",
	"failed",
	"awaiting_review",
	"rejected",
] as const;
export type CheckpointLifecycle = (typeof CHECKPOINT_LIFECYCLES)[number];

export const artifactSchema = z.object({
	path: z.string().min(1),
	hash: z.string().min(1),
});
/** 预留导出（契约面）：当前无生产引用，保留为公共 API（issue #4，2026-09-13）。 */
export type Artifact = z.infer<typeof artifactSchema>;

export const blackboardEffectsSchema = z
	.object({
		publish: z
			.array(z.object({ key: z.string().min(1), type: z.string().min(1) }))
			.default([]),
		update: z
			.array(
				z.object({
					key: z.string().min(1),
					field: z.string().min(1),
					value: z.unknown(),
				}),
			)
			.default([]),
	})
	.default({ publish: [], update: [] });
/** 预留导出（契约面）：当前无生产引用，保留为公共 API（issue #4，2026-09-13）。 */
export type BlackboardEffects = z.infer<typeof blackboardEffectsSchema>;

export const unblockEntrySchema = z.object({
	goal: z.string().min(1),
});
/** 预留导出（契约面）：当前无生产引用，保留为公共 API（issue #4，2026-09-13）。 */
export type UnblockEntry = z.infer<typeof unblockEntrySchema>;

/**
 * 回退快照（TF-0098）。廉价可逆的前提是恢复点真实存在——
 * 没有快照的 checkpoint 一律拒绝回退，而不是假装成功。
 *
 * 两个面必须分开记录，因为它们是三个不同动作的对象：
 *  - code：代码面，工作区 HEAD commit + 改动文件的内容 hash；
 *  - context：上下文面，blackboard 上会被改动的键在改动前的值（null = 原本不存在）。
 */
export const rollbackSchema = z.object({
	code: z
		.object({
			/** 采集时工作区的 HEAD commit，回退用它还原文件内容。 */
			commit: z.string().min(1),
			/** 相对工作区根的路径（POSIX）。 */
			paths: z.array(z.string()).default([]),
			/** path → 采集时的内容 hash（sha256）。 */
			hashes: z.record(z.string(), z.string()).default({}),
		})
		.optional(),
	context: z.record(z.string(), z.unknown()).optional(),
});
export type Rollback = z.infer<typeof rollbackSchema>;

/**
 * 回退作用域（TF-0098 requirement 2）：三个动作必须是三个有明确标签的
 * 不同动作——Cursor 最持久的投诉就是「Restore Checkpoint 读起来像回滚
 * 对话但实际不是」。这里不给默认值，必须显式三选一。
 */
export const ROLLBACK_SCOPES = ["code", "context", "both"] as const;
export type RollbackScope = (typeof ROLLBACK_SCOPES)[number];

export const SCOPE_LABELS: Record<RollbackScope, string> = {
	code: "恢复代码",
	context: "恢复上下文",
	both: "恢复代码与上下文",
};

/**
 * 验证绑定（2026-09-30，验证时效性）：「验证通过」是关于特定代码状态的声明，
 * 不是永久事实。验证前后采集 HEAD 与改动文件状态，并要求两次一致；
 * runtime 在推进 verified→applied 之前重新采集并比较，不一致就退回 staging
 * 重新验证，而不是把过期绿灯推进成 applied/done。
 *
 * 新验证无法采集或前后状态不一致时停留待审查；旧的无绑定记录保持兼容。
 */
export const verificationContextSchema = z.object({
	/** Canonical cwd used for the check/approval, not just the Git commit. */
	cwd: z.string().min(1),
	strategy: z.string().nullable(),
	command: z.string().nullable(),
	expectedExitCode: z.number().int(),
	timeoutSeconds: z.number().positive(),
	/** A human approval is not evidence that the declared command ran again. */
	authority: z.enum(["command", "human"]),
	fixedRunner: z
		.object({
			name: z.literal("node"),
			version: z.string(),
			executableHash: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.optional(),
	evidence: z
		.object({
			declared: verificationEvidenceSpecSchema,
			inputs: z.record(z.string(), z.string()),
			runner: z.object({
				node: z.string(),
				bun: z.string().nullable(),
				platform: z.string(),
				arch: z.string(),
			}),
		})
		.optional(),
});
export type VerificationContext = z.infer<typeof verificationContextSchema>;

export const verificationBindingSchema = z.object({
	/** 验证完成时工作区的 HEAD commit。 */
	commit: z.string().min(1),
	/** 改动文件的内容 hash；null 明确表示删除，干净工作区为空。 */
	files: z.record(z.string(), z.string().nullable()).default({}),
	/** Optional for legacy records; all new successful checks/approvals bind it. */
	context: verificationContextSchema.optional(),
});
export type VerificationBinding = z.infer<typeof verificationBindingSchema>;

export const checkpointSchema = z.object({
	id: z.string().min(1),
	goal: z.string().min(1),
	workspot: z.string().min(1),
	timestamp: z.string().min(1),
	lifecycle: z.enum(CHECKPOINT_LIFECYCLES),
	assertion: z.string().min(1),
	verification: verificationStrategySchema.optional(),
	artifacts: z.array(artifactSchema).default([]),
	/** Optional, explicit single-artifact contract (ADR-0025). */
	artifact: artifactDeclarationSchema.optional(),
	artifactOrigin: artifactSnapshotSchema.optional(),
	/** Caller-selected historical read records, separate from current file sampling. */
	artifactInputOrigin: artifactInputOriginSchema.optional(),
	artifactBinding: artifactSnapshotSchema.optional(),
	/** Explicit candidate checked on the declared target base; never inferred from hash equality. */
	artifactTargetCandidate: z
		.object({ ref: z.string().min(1), workspot: z.string().min(1) })
		.optional(),
	artifactTargetCheck: z
		.object({
			ref: z.string(),
			baseCommit: z.string(),
			baseTree: z.string(),
			workspot: z.string(),
			candidateCwd: z.string(),
			candidateHead: z.string(),
			objectManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
			at: z.string(),
		})
		.optional(),
	/** One accepted consumption, independently bound to the evidence that authorized effects. */
	artifactConsumption: z
		.object({
			state: z.enum(["started", "applied"]),
			evidenceCheckpointId: z.string().min(1),
			at: z.string(),
			mode: z.enum(["recorded-inputs-v1", "legacy-declared-scope"]),
			manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
			artifactHash: z.string().regex(/^[a-f0-9]{64}$/),
			reportHash: z.string().regex(/^[a-f0-9]{64}$/),
		})
		.optional(),
	/** Rejected consumption stays pending until an explicit corrected consumption. */
	artifactUseIssue: z.string().optional(),
	/** Root checkpoint; rechecks never repeat its effects or complete another goal. */
	revalidates: z.string().min(1).optional(),
	blackboardEffects: blackboardEffectsSchema.optional(),
	unblocks: z.array(unblockEntrySchema).default([]),
	ephemeralGoal: z.string().optional(),
	/**
	 * 会话链接（TF-0196）：checkpoint 由哪个线程/写者产生。旧 checkpoint
	 * 没有这两个字段——可选即兼容，doctor 与所有读侧不得因缺失而报错。
	 * 这是 Verifier 状态的生产者侧链接：验证结论从此可以归因到会话。
	 */
	threadId: z.string().min(1).optional(),
	writerId: z.string().min(1).optional(),
	/** Archived outcome of the last verification run (milestone 6 executor). */
	verificationResult: z
		.object({
			status: z.string(),
			output: z.string().optional(),
			at: z.string(),
			exitCode: z.number().int().nullable().optional(),
			evidence: verificationEvidenceSchema.optional(),
			object: verificationObjectSchema.optional(),
		})
		.optional(),
	/** Verification can pass while applying the declared registry changes fails. */
	applicationError: z.string().optional(),
	/**
	 * 验证绑定：验证完成时的代码状态。缺失 = 该次验证不可比较（旧 checkpoint
	 * 的历史记录），保持既有行为；新采集问题另记 verificationBindingIssue。
	 */
	verificationBinding: verificationBindingSchema.optional(),
	/** 本次验证的代码状态未知/不稳定，检查退出成功也不能自动推进。 */
	verificationBindingIssue: z.string().optional(),
	/** 上一次因代码变化而退回重验的原因（保留为读数，不随重验清除）。 */
	verificationInvalidatedAt: z.string().optional(),
	verificationInvalidatedReason: z.string().optional(),
	/** 回退快照（TF-0098）；缺失即无恢复点，回退必须拒绝。 */
	rollback: rollbackSchema.optional(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;
