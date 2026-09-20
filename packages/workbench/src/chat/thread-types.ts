import type { ForkInheritance, ForkLineage } from "./fork";

import type { PromotionRecord } from "./promote";

import type { ChatProvider, ReadObservability } from "./provider-capabilities";
import { readObservabilityOf } from "./provider-capabilities";

import type { ResumeNote } from "./resume";

export type PermissionMode = "default" | "plan" | "acceptEdits";

// TF-0204: the provider vocabulary lives in `provider-capabilities.ts` so that
// "what can this provider do" has exactly one answer. Re-exported here because
// this module is where the thread model's consumers already import it from.
export type { ChatProvider, ReadObservability };
export { readObservabilityOf };

export interface ThreadLastRun {
	provider: ChatProvider;
	readObservability: ReadObservability;
	at: string;
}

/**
 * 收养身份快照（TF-0200）：只记身份指针，恒为常数大小，反转成本与消息量无关。
 * 收养时挂在被归档的源线程上，revert 一次性消费它把双方身份复归收养前。
 */
export interface AdoptSnapshot {
	id: string;
	version: number;
	sourceThreadId: string;
	sourceArchivedBefore: boolean;
	adoptedThreadId: string;
	adoptedForkOfBefore: ForkLineage;
	adoptedArchivedBefore: boolean;
	/** 锚点：源线程收养时刻的末条消息 id，界定其后哪些消息不并入。 */
	anchorMessageId?: string;
	at: string;
}

export type { ResumeBeat, ResumeNote } from "./resume";

export interface ThreadMeta {
	id: string;
	title: string;
	createdAt: string;
	/**
	 * The claude session id. New threads mint a uuid at creation and pass it
	 * to the CLI via --session-id, so the thread directory name IS the claude
	 * session id (R1: the dual identifier is collapsed). --resume reuses it;
	 * a reload mints a fresh uuid (the conversation diverged).
	 */
	claudeSessionId?: string;
	/** Set once a run completed — the next run uses --resume. */
	hasResumableSession?: boolean;
	status: "idle" | "running";
	/** plan 模式下跑出的最后回复即计划，UI 渲染批准卡 */
	permissionMode: PermissionMode;
	archived?: boolean;
	/**
	 * 分叉计数（TF-0092 触发信号「同一条消息上第二次分叉」）：
	 * message id → 在该消息上分叉（含 reload）的次数。
	 */
	forks?: Record<string, number>;
	/** 晋升记录（TF-0092）：何时、因哪些信号、命名成什么。可观测，不参与自动动作。 */
	promotion?: PromotionRecord;
	/** 分叉血统（TF-0093）：本线程由哪个线程的哪条消息分叉而来。 */
	forkOf?: ForkLineage;
	/** 分叉后的真实 provider 继承观测；首次运行前字段为 pending。 */
	forkInheritance?: ForkInheritance;
	/**
	 * 最近一轮实际使用的 provider 与读集可观测性。provider 是全局配置，同一线程
	 * 的不同轮次可能换过 provider，所以这是每轮记录的事实，不能从当前配置推。
	 * 从未运行过的线程没有这个字段。
	 */
	lastRun?: ThreadLastRun;
	/** 准备恢复笔记（TF-0097）：离开车道时由 agent 起草，返回时呈现为有序叙事。 */
	resumeNote?: ResumeNote;
	/**
	 * 收养身份快照（TF-0200）：收养时挂在被归档的源线程上，供一次性反转定位。
	 * 整份快照存下 revert 还原身份所需的 *Before 字段与锚点。
	 */
	adoptSnapshot?: AdoptSnapshot;
}

export type ToolCallPart = {
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	args: unknown;
	/** tool_result 回填后可展示 */
	result?: unknown;
	/** Provider reported that the tool result is an error. */
	isError?: boolean;
};

/** Presentation-only grouping; all original tool facts remain available in tools. */
export interface CollapsedGroupPart {
	type: "collapsed-group";
	id: string;
	category: "search" | "read" | "shell" | "mixed";
	tools: ToolCallPart[];
	/** Whether the last tool in the group is still executing. */
	active: boolean;
	/** Human-readable summary, e.g. `搜索 'foo'（2×），读取 3 个文件`. */
	summary: string;
}

/**
 * Something the operator must see that the assistant did not say: today, the
 * CLI refusing an action. It lives in the assistant message because that is
 * where it happened, but it is styled as a notice rather than as the agent's
 * own words. Shape mirrors the legacy `MessagePart::SystemNotice`.
 */
export interface NoticePart {
	type: "notice";
	severity: "info" | "warning";
	label: string;
	body?: string;
}

export type MessagePart =
	| { type: "text"; text: string }
	| ToolCallPart
	| NoticePart;

/**
 * What a stored message part may be: a basic part, or a folded group wrapping
 * several tool calls. `collapseParts` turns the former into the latter, and it
 * is the post-collapse shape that is persisted — the client renders exactly
 * what was stored instead of re-deriving it.
 */
export type StoredPart = MessagePart | CollapsedGroupPart;

export interface StoredMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	at: string;
	/** assistant 消息的结构化内容（text / tool-call / collapsed-group）；user 消息省略 */
	parts?: StoredPart[];
	/** 扇出的备选文本（TF-0094）：不含主回答，最多 fanout-1 条。 */
	variants?: string[];
}

export type TurnRunEvent =
	/** Newly received text only; never the accumulated projection. */
	| { type: "delta"; text: string }
	/** Complete folded snapshot after a visible structural change. */
	| { type: "parts"; parts: StoredPart[] }
	/** Authoritative message, identical to the persisted transcript entry. */
	| { type: "done"; message: StoredMessage }
	| { type: "error"; message: string }
	| { type: "notice_delivered"; count: number };

/** NDJSON events exposed by the Workbench chat route. */
export type RunEvent =
	| { type: "user"; message: StoredMessage }
	| { type: "turn_started"; messageId: string }
	/** Request failures may precede allocation of an assistant message. */
	| { type: "error"; message: string; messageId?: string }
	| (Exclude<TurnRunEvent, { type: "error" }> & { messageId: string });
