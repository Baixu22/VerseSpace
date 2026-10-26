import { z } from "zod";

/**
 * R3 / TF-0081: the adjudication queue — where every "the machine wants a
 * human" event lands, gets rationalized, and waits for a decision.
 *
 * Before R3, `notify_human` was a discarded array: 9 emitters across three
 * state machines and the scheduler produced messages that the runtime pushed
 * into a list nobody owned. Here the event is the unit of record: it is
 * rationalized on the way in (ISA-18.2), prioritized by consequence ×
 * response deadline, aggregated by cause, shelved with an expiry, and only
 * then shown to a human.
 *
 * Two orthogonal axes, deliberately kept apart:
 * - `priority` is an SLA label (how soon a human owes this a decision), not a
 *   confidence grade. TF-0082 forbids likelihood-graded alarms; sorting by
 *   deadline is not grading by likelihood.
 * - `push` is the binary human-channel decision (TF-0082). Everything below
 *   the push threshold still lands in the queue as pull-style soft summary.
 */

export const TRIBUNAL_PRIORITIES = [
	"critical",
	"high",
	"medium",
	"low",
] as const;
export type TribunalPriority = (typeof TRIBUNAL_PRIORITIES)[number];

/** Every kind must be able to answer "what does the human do differently". */
export const TRIBUNAL_KINDS = [
	"dependency_missing",
	"dependency_dead",
	"workspot_blocked",
	"workspot_orphan_task",
	"checkpoint_needs_review",
	"checkpoint_no_policy",
	"queue_stale_entries",
	"no_idle_workspot",
	"concurrency_cap",
	"dispatch_suggestion",
	/** R3 / TF-0084: per-lane metrics crossed a distress line. */
	"metric_tool_bloat",
	"metric_cache_miss",
	"metric_suspend",
	/** R2 / TF-0079: 派发前的合并预检给出了答案（真冲突 / 稀有重叠）。 */
	"merge_conflict_predicted",
	"write_overlap_rare",
	/**
	 * issue #6 item 12: 这两条此前只有 `log` 与 `/api/state` 活动流里的通用
	 * 日志行，派发失败与 agent 崩溃循环因此没有专门的可观测面。现在各自
	 * 有裁决项，会走 rationalization + 推送阈值，不再被日志淹没。
	 */
	"dispatch_failed",
	"agent_crashloop",
] as const;
export type TribunalKind = (typeof TRIBUNAL_KINDS)[number];

/**
 * ISA-18.2 rationalization rules — the five QUALITATIVE tests. An event that
 * fails any one of them is not an alarm and never reaches a human; it is
 * recorded as suppressed so the rationalization itself stays auditable.
 */
export const RATIONALIZATION_RULES = [
	"abnormal",
	"consequence",
	"actionable",
	"relevant",
	"unique",
] as const;
export type RationalizationRule = (typeof RATIONALIZATION_RULES)[number];

/**
 * The quantitative floor is the sixth way an event can be refused, and it is
 * deliberately NOT one of the five: ISO/ISA rationalization is qualitative
 * (does this event deserve a human at all), while the soft floor is a
 * queue decision (is this event loud enough, given what else is queued).
 * Keeping them apart is what lets the queue apply the floor only to events
 * that have no cause-twin to fold into — the thirtieth session interrupted by
 * one dead dependency scores low on its own, and folding it is exactly how the
 * queue notices the cause matters.
 */
export const REJECTION_RULES = [
	...RATIONALIZATION_RULES,
	"soft_floor",
] as const;
export type RejectionRule = (typeof REJECTION_RULES)[number];

export const tribunalActionSchema = z.object({
	/** What the human does differently. No action ⇒ not an alarm. */
	label: z.string().min(1),
	/** Runnable when the action is a command (rendered, never auto-run). */
	command: z.string().optional(),
});
export type TribunalAction = z.infer<typeof tribunalActionSchema>;

/**
 * SBAR card (TF-0082). The shape is fixed and the last field is always the
 * recommendation: a card that ends in a question asks the human to do the
 * reasoning the machine already did.
 */
export const tribunalSbarSchema = z.object({
	situation: z.string(),
	background: z.string(),
	assessment: z.string(),
	recommendation: z.string(),
});
export type TribunalSbar = z.infer<typeof tribunalSbarSchema>;

/** A twin event folded into the first one that carried the same cause. */
export const tribunalFoldedSchema = z.object({
	subject: z.string(),
	at: z.string(),
	detail: z.string().default(""),
});

export const TRIBUNAL_ITEM_STATES = [
	"pending",
	"shelved",
	"resolved",
	"expired",
] as const;

export const tribunalItemSchema = z.object({
	id: z.string().min(1),
	kind: z.enum(TRIBUNAL_KINDS),
	priority: z.enum(TRIBUNAL_PRIORITIES),
	/** Consequence severity, 0..1 (ISA-18.2: priority = severity × urgency). */
	severity: z.number().min(0).max(1),
	/** Response deadline in minutes — the other half of the priority. */
	urgencyMinutes: z.number().positive(),
	/** Combined 0..1 score the human-facing threshold reads. */
	score: z.number().min(0).max(1),
	/** Binary push decision: pushed to the human channel, or pull-only. */
	push: z.boolean(),
	/** NEWS2-style single-parameter override: one red value outranks the score. */
	escalated: z.boolean().default(false),
	escalationReason: z.string().optional(),
	/** What this is about (goal / workspot / checkpoint id, or a path). */
	subject: z.string(),
	/** Aggregation key: one cause打断 30 sessions ⇒ one item carrying 30. */
	causeKey: z.string(),
	action: tribunalActionSchema,
	sbar: tribunalSbarSchema,
	folded: z.array(tribunalFoldedSchema).default([]),
	state: z.enum(TRIBUNAL_ITEM_STATES).default("pending"),
	shelvedUntil: z.string().optional(),
	/** How often this was shelved — the shelve count itself is a KPI. */
	shelveCount: z.number().int().nonnegative().default(0),
	createdAt: z.string(),
	updatedAt: z.string(),
	resolvedAt: z.string().optional(),
});
export type TribunalItem = z.infer<typeof tribunalItemSchema>;

/**
 * A raw event offered to the queue. Everything the rationalization gate
 * needs, nothing the queue decides (id / priority / score / state).
 */
export interface TribunalCandidate extends TribunalEnvelope {
	at?: string;
}

/**
 * What an emitter attaches to a `notify_human` transition so the queue can
 * rationalize it. Identical to a candidate minus `at`, which the queue stamps
 * when the event is actually offered (an emitter computes its envelope long
 * before the runtime decides to submit it).
 */
export interface TribunalEnvelope {
	kind: TribunalKind;
	subject: string;
	/** Same cause ⇒ folded into one item. Defaults to `kind:subject`. */
	causeKey?: string;
	/** Overrides the kind's baseline consequence (0..1). */
	severity?: number;
	/** Overrides the kind's baseline response deadline. */
	urgencyMinutes?: number;
	action: TribunalAction;
	sbar: TribunalSbar;
	/** Paths / commands the NEWS2 escalation scan inspects. */
	evidence?: {
		paths?: string[];
		commands?: string[];
		content?: string;
	};
	/** Extra line for the folded twin's `detail`. */
	detail?: string;
}

export type SubmitResult =
	| { admitted: true; item: TribunalItem; folded: boolean }
	| {
			admitted: false;
			rule: RejectionRule;
			reason: string;
			/** Set when the rejection was a fold into an existing item. */
			foldedInto?: string;
	  };
