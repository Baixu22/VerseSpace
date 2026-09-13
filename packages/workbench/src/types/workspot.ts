import { z } from "zod";
import { normalizeBranchName } from "../git/refname";

export const WORKSPOT_BINDINGS = ["primary", "borrowed", "idle"] as const;
/** 预留导出（契约面）：当前无生产引用，保留为公共 API（issue #4，2026-09-13）。 */
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
/** 预留导出（契约面）：当前无生产引用，保留为公共 API（issue #4，2026-09-13）。 */
export type ContextNeeds = z.infer<typeof contextNeedsSchema>;

export const workspotSchema = z.object({
	id: z.string().min(1),
	/**
	 * TF-0117: normalized on the way in, but deliberately NOT rejected here.
	 * This schema is also the read path (`workspots.get` parses stored YAML), so
	 * a refinement would turn a hand-edited or pre-validation workspot into a
	 * thrown `BlackboardDataError` on every read — replacing an opaque git
	 * failure with an opaque parse failure. Validation lives at the two places
	 * that can act on it: `workbench ws create` refuses new bad names, and
	 * dispatch pre-checks before creating a worktree and returns a structured
	 * refusal into the adjudication queue.
	 */
	branch: z.string().min(1).transform(normalizeBranchName),
	worktreePath: z.string().min(1),
	primaryTask: z.string().min(1),
	currentTask: z.string().optional(),
	binding: z.enum(WORKSPOT_BINDINGS).default("primary"),
	status: z.enum(WORKSPOT_STATUSES).default("idle"),
	contextNeeds: contextNeedsSchema,
});
export type Workspot = z.infer<typeof workspotSchema>;
