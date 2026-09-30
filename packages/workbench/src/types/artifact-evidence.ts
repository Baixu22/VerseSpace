import { z } from "zod";
import { evidencePathSchema } from "./verification-evidence";

export const artifactDeclarationSchema = z.object({
	path: evidencePathSchema,
	/** Strong evidence is declared only; observations are never inferred as causality. */
	inputs: z.array(evidencePathSchema).min(1),
	source: z.literal("declared").default("declared"),
	targetRef: z
		.string()
		.min(1)
		.refine((ref) => !ref.startsWith("-") && !/[\r\n\0]/.test(ref))
		.optional(),
});
export type ArtifactDeclaration = z.infer<typeof artifactDeclarationSchema>;

export const artifactSnapshotSchema = z.object({
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
