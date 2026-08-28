import { z } from "zod";

export const GOAL_STATUSES = [
	"planned",
	"ready",
	"in_progress",
	"done",
	"stale_done",
	"cancelled",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const VERIFICATION_STRATEGIES = [
	"test",
	"type-check",
	"build",
	"human-review",
] as const;
export type VerificationStrategyName = (typeof VERIFICATION_STRATEGIES)[number];

export const verificationStrategySchema = z.object({
	strategy: z.enum(VERIFICATION_STRATEGIES),
	command: z.string().min(1).optional(),
	expectedExitCode: z.number().int().optional(),
	timeout: z.number().int().positive().optional(),
});
export type VerificationStrategy = z.infer<typeof verificationStrategySchema>;

export const acceptanceCriteriaSchema = z.object({
	assertion: z.string().min(1),
	verification: verificationStrategySchema.optional(),
});
export type AcceptanceCriteria = z.infer<typeof acceptanceCriteriaSchema>;

export const goalSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	status: z.enum(GOAL_STATUSES),
	acceptance: z.array(acceptanceCriteriaSchema).default([]),
	dependsOn: z.array(z.string()).default([]),
	checkpoints: z.array(z.string()).default([]),
	verifiedAgainst: z
		.object({
			interfaces: z.record(z.string(), z.number()),
			decisions: z.array(z.string()),
		})
		.default({ interfaces: {}, decisions: [] }),
	staleReason: z.string().optional(),
});
export type Goal = z.infer<typeof goalSchema>;
