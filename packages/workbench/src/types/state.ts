import { z } from "zod";

/** Queue file shape (blackboard/state/execution/queue.yaml). */
export const queueFileSchema = z.object({
	queue: z.array(z.string()).default([]),
});
export type QueueFile = z.infer<typeof queueFileSchema>;

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
