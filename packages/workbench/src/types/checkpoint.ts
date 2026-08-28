import { z } from "zod";
import { verificationStrategySchema } from "./goal";

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
export type BlackboardEffects = z.infer<typeof blackboardEffectsSchema>;

export const unblockEntrySchema = z.object({
	goal: z.string().min(1),
});
export type UnblockEntry = z.infer<typeof unblockEntrySchema>;

export const checkpointSchema = z.object({
	id: z.string().min(1),
	goal: z.string().min(1),
	workspot: z.string().min(1),
	timestamp: z.string().min(1),
	lifecycle: z.enum(CHECKPOINT_LIFECYCLES),
	assertion: z.string().min(1),
	verification: verificationStrategySchema.optional(),
	artifacts: z.array(artifactSchema).default([]),
	blackboardEffects: blackboardEffectsSchema.optional(),
	unblocks: z.array(unblockEntrySchema).default([]),
	ephemeralGoal: z.string().optional(),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;
