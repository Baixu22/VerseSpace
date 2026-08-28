import { z } from "zod";

export const decisionSchema = z.object({
	id: z.string().min(1),
	title: z.string().min(1),
	rationale: z.string().min(1),
	timestamp: z.string().min(1),
	author: z.string().min(1),
});
export type Decision = z.infer<typeof decisionSchema>;
