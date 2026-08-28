import { z } from "zod";

export const WORKSPOT_BINDINGS = ["primary", "borrowed", "idle"] as const;
export type WorkspotBinding = (typeof WORKSPOT_BINDINGS)[number];

export const WORKSPOT_STATUSES = [
	"idle",
	"active",
	"blocked",
	"completed",
] as const;
export type WorkspotStatus = (typeof WORKSPOT_STATUSES)[number];

export const contextNeedsSchema = z
	.object({
		decisions: z.array(z.string()).default([]),
		interfaces: z.array(z.string()).default([]),
		eventsFilter: z
			.object({
				tags: z.array(z.string()).default([]),
				lastN: z.number().int().positive(),
			})
			.optional(),
	})
	.default({ decisions: [], interfaces: [] });
export type ContextNeeds = z.infer<typeof contextNeedsSchema>;

export const workspotSchema = z.object({
	id: z.string().min(1),
	branch: z.string().min(1),
	worktreePath: z.string().min(1),
	primaryTask: z.string().min(1),
	currentTask: z.string().optional(),
	binding: z.enum(WORKSPOT_BINDINGS).default("primary"),
	status: z.enum(WORKSPOT_STATUSES).default("idle"),
	contextNeeds: contextNeedsSchema,
});
export type Workspot = z.infer<typeof workspotSchema>;
