import { z } from "zod";

export const schedulerPolicies = ["manual", "semi-auto", "auto"] as const;
export type SchedulerPolicy = (typeof schedulerPolicies)[number];

const DEFAULT_AGENT_COMMAND = "claude -p --verbose --output-format stream-json";

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
	/**
	 * The seal point (R2 · TF-0078, observability by TF-0134). It is the one
	 * place the runtime may interrupt a writer, so its posture is configurable:
	 *
	 * - `block` (default): refuse the write, hand the evidence back on stderr;
	 * - `warn`: let the write through, still hand the evidence back;
	 * - `off`: let the write through, still record and print the reason.
	 *
	 * No mode is silent. `off` turns off the interruption, never the
	 * observation — the runtime's posture everywhere else is observe and
	 * notify, and a seal that hides what it saw would be worse than no seal.
	 */
	seal: z
		.object({
			mode: z.enum(["block", "warn", "off"]).default("block"),
			/**
			 * Consecutive unresolved hits against one writer before the seal
			 * downgrades itself to `warn`. A seal that keeps stopping the same
			 * writer has stopped being evidence and become an obstacle. The
			 * downgrade holds until that writer clears the stale premise or
			 * moves on, so it cannot oscillate block/warn/block.
			 */
			consecutiveBlockLimit: z.number().int().positive().default(3),
		})
		.default({ mode: "block", consecutiveBlockLimit: 3 }),
	thresholds: z
		.object({
			idleNotification: z.string().default("15m"),
			checkpointTimeout: z.string().default("5m"),
		})
		.default({ idleNotification: "15m", checkpointTimeout: "5m" }),
	/** Agent CLI invoked per workspot (batch mode reads the prompt on stdin). */
	agent: z
		.object({
			// --verbose is required by current claude CLI with stream-json in
			// --print mode ("...requires --verbose"); the chat lane already ships
			// it. Without it the agent lane's default errors before any prompt.
			command: z
				.string()
				.default(DEFAULT_AGENT_COMMAND)
				.transform((command) =>
					command === "claude -p --output-format stream-json"
						? DEFAULT_AGENT_COMMAND
						: command,
				),
		})
		.default({ command: DEFAULT_AGENT_COMMAND }),
	/**
	 * Chat runtime provider. claude and codex = local CLI (both leave tool
	 * footprints — claude speaks stream-json, codex speaks the app-server
	 * JSON-RPC protocol, see ADR-0017); the rest are HTTP streaming APIs. A
	 * saved apiKey takes precedence over the optional WORKBENCH_CHAT_API_KEY
	 * environment credential. The latter is never saved; the UI masks
	 * credentials and GET /api/config/chat never returns them.
	 */
	chat: z
		.object({
			provider: z
				.enum([
					"claude",
					"codex",
					"openai-chat",
					"openai-responses",
					"anthropic",
				])
				.default("claude"),
			model: z.string().optional(),
			apiKey: z.string().optional(),
			baseUrl: z.string().optional(),
			temperature: z.number().min(0).max(2).optional(),
			maxTokens: z.number().int().positive().optional(),
			effort: z.enum(["low", "medium", "high"]).optional(),
			/**
			 * 自动扇出变体数（TF-0094）：≥2 时同一请求并发发 shadow 变体，
			 * 主回答照常展示，备选挂在消息上一击展开。1 = 关（默认）。
			 */
			fanout: z.number().int().min(1).max(3).optional(),
			/** Maximum approximate token budget for one premise notice bundle. */
			noticeTokenBudget: z.number().int().positive().max(4000).default(300),
		})
		.default({ provider: "claude", noticeTokenBudget: 300 }),
	/**
	 * Per-event line budget in characters for `.agent-context.md` (TF-0145):
	 * a world event's payload never reaches the agent context unbounded —
	 * context volume must not grow with payload size.
	 */
	contextgen: z
		.object({
			eventLineChars: z.number().int().positive().max(100_000).default(400),
		})
		.default({ eventLineChars: 400 }),
});
export type WorkbenchConfig = z.infer<typeof workbenchConfigSchema>;
/**
 * Values accepted when saving config.  Zod defaults make nested fields
 * optional on input, so callers can update just the setting they own while
 * the persisted representation is still canonicalized by the schema.
 */
export type WorkbenchConfigInput = z.input<typeof workbenchConfigSchema>;
