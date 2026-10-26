import { z } from "zod";
import { inputSelectorSchema } from "../blackboard/session-types";
import { verificationObjectSchema } from "./verification-evidence";

export const manifestHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const gitHash = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
/** Canonical, relative file names; no traversal, drive, ADS or control bytes. */
export const manifestPathSchema = z
	.string()
	.min(1)
	.max(512)
	.refine(
		(path) =>
			!/[\\:*?<>|]/.test(path) &&
			[...path].every((char) => char.charCodeAt(0) >= 32) &&
			path.split("/").every((part) => !!part && part !== "." && part !== ".."),
	);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const testName = z
	.string()
	.min(1)
	.max(512)
	.refine(
		(name) =>
			!/[a-z]:[\\/]/i.test(name) &&
			[...name].every((char) => char.charCodeAt(0) >= 32),
	);
const strength = z.enum(["tool-observed", "fs-sample", "declared", "unknown"]);
const file = z.strictObject({
	path: manifestPathSchema,
	hash: manifestHashSchema,
	bytes: count,
});

export const portableObjectSchema = verificationObjectSchema
	.pick({
		schemaVersion: true,
		mode: true,
		script: true,
		reportPath: true,
		bootstrapHash: true,
		files: true,
		manifestHash: true,
		runner: true,
		reportHash: true,
		copyBytes: true,
		copyMs: true,
		runMs: true,
		limitations: true,
	})
	.extend({
		script: manifestPathSchema,
		reportPath: manifestPathSchema,
		files: z.array(file).min(1).max(128),
		runner: z.strictObject({
			name: z.literal("node"),
			version: z.string().regex(/^[a-z0-9.+_-]{1,64}$/i),
			executableHash: manifestHashSchema,
		}),
	});

export const artifactManifestBodySchema = z.strictObject({
	schemaVersion: z.literal(1),
	kind: z.literal("workbench-artifact-evidence"),
	artifact: z.strictObject({
		path: manifestPathSchema,
		hash: manifestHashSchema.nullable(),
	}),
	inputs: z
		.array(
			z.strictObject({
				path: manifestPathSchema,
				checkedHash: manifestHashSchema.nullable(),
			}),
		)
		.min(1)
		.max(128),
	origin: z.strictObject({
		strength,
		/** Exporter checked its own historical records; recipient must still verify locally. */
		locallyMatched: z.boolean(),
		workspotHash: manifestHashSchema.nullable(),
		reads: z
			.array(
				z.strictObject({
					path: manifestPathSchema,
					writerHash: manifestHashSchema,
					footprintSeq: count,
					eventHash: manifestHashSchema.nullable(),
					eventSeq: count.nullable(),
					selector: inputSelectorSchema,
					version: manifestHashSchema.nullable(),
					source: strength,
					binding: z.enum(["matched", "different", "unknown"]),
					contentHash: manifestHashSchema.nullable(),
					returnedHash: manifestHashSchema.nullable(),
				}),
			)
			.max(128),
	}),
	scope: z.strictObject({
		mode: z.enum(["node-offline-files-v1", "workspace-command-v1"]),
		complete: z.boolean(),
		script: manifestPathSchema.nullable(),
		configPaths: z.array(manifestPathSchema).max(128),
		reportPath: manifestPathSchema,
		expectedTests: z.array(testName).min(1).max(512),
	}),
	verification: z.strictObject({
		result: z.enum([
			"passed",
			"failed",
			"needs_human",
			"timeout",
			"skipped",
			"unknown",
		]),
		current: z.enum(["current", "stale", "pending", "failed", "unknown"]),
		scopeStatus: z.enum(["satisfied", "unsatisfied", "unknown"]),
		authority: z.enum(["command", "human", "unknown"]),
		exitCode: z.number().int().nullable(),
		reportHash: manifestHashSchema.nullable(),
		actualTests: z
			.array(z.strictObject({ name: testName, status: z.string().max(32) }))
			.max(512),
		counts: z.strictObject({
			total: count,
			passed: count,
			failed: count,
			skipped: count,
		}),
		object: portableObjectSchema.nullable(),
	}),
	context: z.strictObject({
		rootHash: manifestHashSchema,
		checkpointHash: manifestHashSchema,
		workspotHash: manifestHashSchema,
		head: gitHash.nullable(),
		platform: z.enum(["win32", "darwin", "linux", "unknown"]),
		arch: z.enum(["x64", "arm64", "unknown"]),
		timeoutSeconds: z.number().positive().nullable(),
	}),
	target: z.strictObject({
		status: z.enum([
			"target-checked",
			"inputs-match",
			"inputs-differ",
			"unknown",
		]),
		ref: z
			.string()
			.min(1)
			.max(256)
			.regex(/^[a-z0-9_./-]+$/i)
			.nullable(),
		baseRef: z
			.string()
			.min(1)
			.max(256)
			.regex(/^[a-z0-9_./-]+$/i)
			.nullable(),
		currentRef: z
			.string()
			.min(1)
			.max(256)
			.regex(/^[a-z0-9_./-]+$/i)
			.nullable(),
		baseCommit: gitHash.nullable(),
		baseTree: gitHash.nullable(),
		currentCommit: gitHash.nullable(),
		currentTree: gitHash.nullable(),
		change: z.enum([
			"none",
			"outside-declared-range",
			"revalidation-required",
			"unknown",
		]),
		blobs: z
			.array(
				z.strictObject({ path: manifestPathSchema, hash: gitHash.nullable() }),
			)
			.max(128),
		currentBlobs: z
			.array(
				z.strictObject({ path: manifestPathSchema, hash: gitHash.nullable() }),
			)
			.max(128),
		candidate: z
			.strictObject({
				workspotHash: manifestHashSchema,
				head: gitHash,
				objectHash: manifestHashSchema,
			})
			.nullable(),
	}),
	limitations: z.literal(
		"Unsigned declared-scope evidence; recipient must verify objects and run its own local policy",
	),
});
export const artifactManifestSchema = artifactManifestBodySchema.extend({
	digest: manifestHashSchema,
});
export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
