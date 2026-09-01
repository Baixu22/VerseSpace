import { z } from "zod";

/**
 * Legacy queue shape (a single queue.yaml holding the whole array) — kept
 * only so pre-0.3 workspaces migrate transparently to one-file-per-entry.
 */
export const queueFileSchema = z.object({
	queue: z.array(z.string()).default([]),
});
export type QueueFile = z.infer<typeof queueFileSchema>;

/** One queue entry file: blackboard/state/queue/<goalId>.yaml. */
export const queueEntrySchema = z.object({
	goalId: z.string().min(1),
	/** Best-effort FIFO position; ties resolve alphabetically by goalId. */
	seq: z.number().int().nonnegative(),
});
export type QueueEntry = z.infer<typeof queueEntrySchema>;

/**
 * Known contradiction between two parts of the blackboard (e.g. a workspot is
 * `active` but its primary goal is `cancelled`). Detection is doctor/automaton
 * territory (milestone ten); the data layer only stores what was reported.
 */
export const conflictSchema = z.object({
	id: z.string().min(1),
	kind: z.string().min(1),
	detail: z.string().min(1),
	createdAt: z.string().min(1),
});
export type Conflict = z.infer<typeof conflictSchema>;

export const conflictsFileSchema = z.object({
	conflicts: z.array(conflictSchema).default([]),
});
export type ConflictsFile = z.infer<typeof conflictsFileSchema>;
