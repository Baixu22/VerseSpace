import { z } from "zod";

export const schedulerPolicies = ["manual", "semi-auto", "auto"] as const;
export type SchedulerPolicy = (typeof schedulerPolicies)[number];

export const workbenchConfigSchema = z.object({
	project: z.string().default(""),
	scheduler: z
		.object({
			policy: z.enum(schedulerPolicies).default("manual"),
			autoConstraints: z
				.object({
					maxConcurrentWorkspots: z.number().int().positive(),
				})
				.optional(),
		})
		.default({ policy: "manual" }),
	protection: z
		.object({
			readonlyAreas: z.array(z.string()).default([]),
			gitHook: z.boolean().default(false),
		})
		.default({ readonlyAreas: [], gitHook: false }),
	thresholds: z
		.object({
			idleNotification: z.string().default("15m"),
			checkpointTimeout: z.string().default("5m"),
		})
		.default({ idleNotification: "15m", checkpointTimeout: "5m" }),
	/** Agent CLI invoked per workspot (batch mode reads the prompt on stdin). */
	agent: z
		.object({
			command: z.string().default("claude -p --output-format stream-json"),
		})
		.default({ command: "claude -p --output-format stream-json" }),
	/**
	 * Chat runtime provider. claude = local CLI (stream-json); the rest are
	 * HTTP streaming APIs. apiKey lives in workbench.yaml (local personal
	 * tool) — the UI masks it and GET /api/config/chat never returns it.
	 */
	chat: z
		.object({
			provider: z
				.enum(["claude", "openai-chat", "openai-responses", "anthropic"])
				.default("claude"),
			model: z.string().optional(),
			apiKey: z.string().optional(),
			baseUrl: z.string().optional(),
			temperature: z.number().min(0).max(2).optional(),
			maxTokens: z.number().int().positive().optional(),
			effort: z.enum(["low", "medium", "high"]).optional(),
		})
		.default({ provider: "claude" }),
});
export type WorkbenchConfig = z.infer<typeof workbenchConfigSchema>;
