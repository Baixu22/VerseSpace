import { z } from "zod";

/** Who can touch the repository: agent sessions, the human, git, CI. */
export const WRITER_KINDS = ["agent", "human", "git", "ci"] as const;
export type WriterKind = (typeof WRITER_KINDS)[number];

export const WRITER_STATUSES = ["active", "idle", "closed"] as const;
export type WriterStatus = (typeof WRITER_STATUSES)[number];

/** One registered writer: blackboard/sessions/<writer>/writer.yaml. */
export const writerSchema = z.object({
	id: z.string().min(1),
	kind: z.enum(WRITER_KINDS),
	label: z.string().default(""),
	status: z.enum(WRITER_STATUSES).default("active"),
	/** Goal / workspot the writer is attached to, when known. */
	task: z.string().optional(),
	workspot: z.string().optional(),
	startedAt: z.string().min(1),
	lastActiveAt: z.string().min(1),
});
export type Writer = z.infer<typeof writerSchema>;
