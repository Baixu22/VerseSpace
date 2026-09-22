import { asRecord, itemOf, stringField } from "./codex-render-blocks";

/**
 * Explicit rendering consequence for every codex `app-server` stream shape we
 * accept (TF-0248). Same contract as `render-decision.ts` for Claude: a shape
 * with no decision returns `undefined`, which the reducer surfaces as an
 * `undecided` coverage gap rather than silently dropping — so a codex CLI
 * upgrade that adds an event type is audible, not invisible.
 */
export type CodexRenderDecision =
	| "finalized"
	| "streaming-delta"
	| "noop"
	/** The turn failed; the router owns the terminal error frame. */
	| "error";

export interface CodexRenderVerdict {
	decision: CodexRenderDecision;
	/** Stable, fixture-auditable event path. */
	key: string;
	reason: string;
}

const verdict = (
	key: string,
	decision: CodexRenderDecision,
	reason: string,
): CodexRenderVerdict => ({ key, decision, reason });

/**
 * Top-level event types that are bookkeeping/telemetry, never a chat part.
 * Each is listed explicitly so the distribution says "seen and decided noop",
 * not "unknown".
 */
const EVENT_NOOP_REASONS: Record<string, string> = {
	"thread/started":
		"session lifecycle; the thread id is captured by the router",
	"thread/status/changed": "idle/active bookkeeping",
	"turn/started": "turn lifecycle; the router tracks the active turn id",
	"turn/completed": "turn terminal frame; the router resolves the turn",
	"turn/plan/updated": "plan/todo bookkeeping, not a Workbench chat part",
	"thread/compacted": "compaction metadata is not a Workbench chat part",
	"thread/tokenUsage/updated":
		"context-usage telemetry (ADR-0017: render noop)",
	"account/rateLimits/updated": "rate-limit telemetry",
	"mcpServer/startupStatus/updated":
		"the codex CLI's own MCP startup, not ours",
	end: "transport sentinel",
};

/** Item types carried by `item/started` / `item/completed`. */
const ITEM_DECISIONS: Record<
	string,
	{
		started: CodexRenderDecision;
		completed: CodexRenderDecision;
		reason: string;
	}
> = {
	userMessage: {
		started: "noop",
		completed: "noop",
		reason: "provider transcript echo of the prompt, not a new local message",
	},
	reasoning: {
		started: "noop",
		completed: "noop",
		reason:
			"reasoning is outside the Workbench thread surface (parity with Claude thinking)",
	},
	agentMessage: {
		// The started frame has empty text; deltas stream in; the completed frame
		// carries the authoritative text.
		started: "noop",
		completed: "finalized",
		reason: "assistant text; completed frame is authoritative",
	},
	commandExecution: {
		started: "finalized",
		completed: "finalized",
		reason: "a shell command — the codex footprint channel",
	},
	collabAgentToolCall: {
		started: "finalized",
		completed: "finalized",
		reason: "sub-agent spawn/wait tool call",
	},
	plan: {
		started: "noop",
		completed: "noop",
		reason: "plan item is task bookkeeping, not a chat part",
	},
	contextCompaction: {
		started: "noop",
		completed: "noop",
		reason: "compaction metadata is not a Workbench chat part",
	},
};

/** The decision for one raw codex line, or undefined when the shape is new. */
export function resolveCodexRenderDecision(
	event: Record<string, unknown>,
): CodexRenderVerdict | undefined {
	const type = stringField(event, "type");

	if (type === "item/agentMessage/delta") {
		return verdict(
			"item/agentMessage/delta",
			"streaming-delta",
			"append only the new text tail",
		);
	}

	if (type === "item/started" || type === "item/completed") {
		const itemType = stringField(itemOf(event), "type");
		const spec = Object.hasOwn(ITEM_DECISIONS, itemType)
			? ITEM_DECISIONS[itemType]
			: undefined;
		if (!spec) return undefined;
		const decision = type === "item/started" ? spec.started : spec.completed;
		return verdict(`${type}.${itemType}`, decision, spec.reason);
	}

	if (type === "turn/completed") {
		// A failed turn carries `turn.status === "failed"`; that path is an error
		// frame the router turns into a visible message. Success is a noop.
		const status = stringField(asRecord(event.turn), "status");
		if (status === "failed") {
			return verdict("turn/completed.failed", "error", "turn failed");
		}
		return verdict(
			"turn/completed",
			"noop",
			"turn terminal frame; the router resolves the turn",
		);
	}

	if (type === "error") {
		return verdict("error", "error", "provider error notification");
	}

	const noopReason = EVENT_NOOP_REASONS[type];
	if (noopReason !== undefined) {
		return verdict(type, "noop", noopReason);
	}

	return undefined;
}

/** Most-specific path used when a codex shape has no decision (coverage gap). */
export function describeCodexEvent(event: Record<string, unknown>): string {
	const type = stringField(event, "type");
	if (type === "item/started" || type === "item/completed") {
		return `${type}.${stringField(itemOf(event), "type")}`;
	}
	return type || "(missing type)";
}
