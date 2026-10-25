import { z } from "zod";
import {
	inputObservationSchema,
	inputSelectorSchema,
} from "../blackboard/session-types";
import { evidencePathSchema } from "./verification-evidence";

export const artifactInputSelectionSchema = z.strictObject({
	path: evidencePathSchema,
	writerId: z.string().min(1),
	footprintSeq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	selector: inputSelectorSchema.optional(),
});
export type ArtifactInputSelection = z.infer<
	typeof artifactInputSelectionSchema
>;

export const artifactDeclarationSchema = z.object({
	path: evidencePathSchema,
	/** Strong evidence is declared only; observations are never inferred as causality. */
	inputs: z.array(evidencePathSchema).min(1),
	source: z.literal("declared").default("declared"),
	/** Explicit records chosen by the caller, never inferred from read/write order. */
	inputRecords: z.array(artifactInputSelectionSchema).min(1).optional(),
	targetRef: z
		.string()
		.min(1)
		.refine((ref) => !ref.startsWith("-") && !/[\r\n\0]/.test(ref))
		.optional(),
});
export type ArtifactDeclaration = z.infer<typeof artifactDeclarationSchema>;

export const artifactInputOriginSchema = z.strictObject({
	schemaVersion: z.literal(1),
	source: z.literal("declared"),
	status: z.enum(["selected", "unknown"]),
	capturedAt: z.string(),
	workspot: z.string(),
	cwd: z.string().optional(),
	reason: z.string(),
	missingInputs: z.array(evidencePathSchema),
	reads: z.array(
		z.strictObject({
			path: evidencePathSchema,
			recordPath: z.string(),
			writerId: z.string().min(1),
			actingAgent: z.string().optional(),
			footprintSeq: z.number().int().positive(),
			eventId: z.string().optional(),
			eventSeq: z.number().int().positive().optional(),
			selector: inputSelectorSchema,
			version: z.string().nullable(),
			size: z.number().optional(),
			contentHash: z.string().optional(),
			strength: z.enum(["tool-observed", "fs-sample", "declared", "unknown"]),
			binding: z.enum(["matched", "different", "unknown"]),
			observation: inputObservationSchema.optional(),
		}),
	),
});
export type ArtifactInputOrigin = z.infer<typeof artifactInputOriginSchema>;

export const artifactSnapshotSchema = z.object({
	/** Sampling at capture time, never historical tool-return provenance. */
	sampling: z.literal("checkpoint-file-sample").optional(),
	repo: z.string(),
	cwd: z.string(),
	head: z.string(),
	files: z.record(z.string(), z.string()),
	target: z
		.object({
			ref: z.string(),
			commit: z.string(),
			tree: z.string(),
			/** Declared input blobs only; never a claim of a merged build. */
			inputsMatch: z.boolean().optional(),
		})
		.optional(),
});
export type ArtifactSnapshot = z.infer<typeof artifactSnapshotSchema>;
