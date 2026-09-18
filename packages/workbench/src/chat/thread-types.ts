import type { WorkbenchConfig } from "../types/config";
import type { ForkInheritance, ForkLineage } from "./fork";

import type { PromotionRecord } from "./promote";

import type { ResumeNote } from "./resume";

export type PermissionMode = "default" | "plan" | "acceptEdits";

export type ChatProvider = WorkbenchConfig["chat"]["provider"];

/** Whether the provider's reads come back as footprints (claude tool channel) or not at all (HTTP). */
export type ReadObservability = "footprint" | "unobservable";

export function readObservabilityOf(provider: ChatProvider): ReadObservability {
	return provider === "claude" ? "footprint" : "unobservable";
}

export interface ThreadLastRun {
	provider: ChatProvider;
	readObservability: ReadObservability;
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
}

export type MessagePart =
	| { type: "text"; text: string }
	| {
			type: "tool-call";
			toolCallId: string;
			toolName: string;
			args: unknown;
			/** tool_result 回填后可展示 */
			result?: unknown;
	  };

export interface StoredMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	at: string;
	/** assistant 消息的结构化内容（text / tool-call）；user 消息省略 */
	parts?: MessagePart[];
	/** 扇出的备选文本（TF-0094）：不含主回答，最多 fanout-1 条。 */
	variants?: string[];
}

export type RunEvent = Record<string, unknown>;
