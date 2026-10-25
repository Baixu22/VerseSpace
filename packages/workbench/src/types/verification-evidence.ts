import { z } from "zod";

/** Paths are relative to the recorded execution directory. */
export const evidencePathSchema = z
	.string()
	.min(1)
	.refine(
		(path) =>
			!/^[\\/]|^[a-z]:/i.test(path) && !path.split(/[\\/]/).includes(".."),
		"证据路径必须在执行目录内",
	);

export const verificationEvidenceSpecSchema = z.object({
	report: z.object({
		format: z.literal("vitest-json"),
		path: evidencePathSchema,
		expectedTests: z
			.array(z.string().min(1))
			.min(1)
			.refine(
				(tests) => new Set(tests).size === tests.length,
				"声明用例不能重名",
			),
	}),
	/** Explicit non-sensitive config/lockfiles; values are never archived. */
	inputs: z.array(evidencePathSchema).default([]),
	/** Trusted offline Node script; the caller declares every local dependency. */
	fixedFiles: z
		.strictObject({
			mode: z.literal("node-offline-files-v1"),
			script: evidencePathSchema,
			complete: z.literal(true),
		})
		.optional(),
});
export type VerificationEvidenceSpec = z.infer<
	typeof verificationEvidenceSpecSchema
>;

export const verificationEvidenceSchema = z.object({
	status: z.enum(["satisfied", "unsatisfied", "unknown"]),
	source: z.literal("vitest-json"),
	reportPath: z.string(),
	reportHash: z.string().optional(),
	expectedTests: z.array(z.string()),
	actualTests: z.array(z.object({ name: z.string(), status: z.string() })),
	counts: z.object({
		total: z.number(),
		passed: z.number(),
		failed: z.number(),
		skipped: z.number(),
	}),
	reason: z.string(),
});
export type VerificationEvidence = z.infer<typeof verificationEvidenceSchema>;

export const verificationObjectSchema = z.strictObject({
	schemaVersion: z.literal(1),
	mode: z.literal("node-offline-files-v1"),
	sourceCwd: z.string(),
	executedCwd: z.string(),
	script: evidencePathSchema,
	reportPath: evidencePathSchema,
	bootstrapHash: z.string().regex(/^[a-f0-9]{64}$/),
	files: z.array(
		z.strictObject({
			path: evidencePathSchema,
			hash: z.string().regex(/^[a-f0-9]{64}$/),
			bytes: z.number().int().nonnegative(),
		}),
	),
	manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
	runner: z.strictObject({
		name: z.literal("node"),
		version: z.string(),
		executableHash: z.string().regex(/^[a-f0-9]{64}$/),
	}),
	reportFile: evidencePathSchema.optional(),
	reportHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
	copyBytes: z.number().int().nonnegative(),
	copyMs: z.number().nonnegative(),
	runMs: z.number().nonnegative(),
	limitations: z.literal(
		"Trusted declared offline files; no hostile-code sandbox or atomic source snapshot",
	),
});
export type VerificationObject = z.infer<typeof verificationObjectSchema>;
