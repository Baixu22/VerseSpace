import { z } from "zod";

export const subscriberSchema = z.object({
	workspot: z.string().min(1),
	reason: z.string().min(1),
});
export type Subscriber = z.infer<typeof subscriberSchema>;

export const registryEntrySchema = z.object({
	key: z.string().min(1),
	canonicalPath: z.string().min(1),
	version: z.number().int().positive(),
	publishedBy: z.string().min(1),
	lastModified: z.string().min(1),
	contentHash: z.string().min(1),
	subscribers: z.array(subscriberSchema).default([]),
});
export type RegistryEntry = z.infer<typeof registryEntrySchema>;

/** Registry identity, revision and timestamps are controlled by the store. */
export const registryUpdateSchema = registryEntrySchema
	.pick({
		canonicalPath: true,
		publishedBy: true,
		contentHash: true,
		subscribers: true,
	})
	.partial()
	.strict();
export type RegistryUpdate = z.infer<typeof registryUpdateSchema>;

export const registrySchema = z.object({
	entries: z.array(registryEntrySchema).default([]),
});
