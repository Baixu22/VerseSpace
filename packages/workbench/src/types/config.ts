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
});
export type WorkbenchConfig = z.infer<typeof workbenchConfigSchema>;
