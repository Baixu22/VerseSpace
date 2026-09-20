import type { ResumeNote } from "./resume-types";

export interface ToolCallPart {
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: unknown;
	isError?: boolean;
}

export interface CollapsedGroupPart {
	type: "collapsed-group";
	id: string;
	category: "search" | "read" | "shell" | "mixed";
	tools: ToolCallPart[];
	active: boolean;
	summary: string;
}

/**
 * 提供方发来的、操作者该看见的信息（今天只有「权限被拒」）。它属于助手消息，
 * 但呈现为通知而不是 agent 自己的话。形状与 workbench 侧 `NoticePart` 一一对应
 * （`protocol.test.ts` 会强制两侧线协议类型互相可赋值）。
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
	| CollapsedGroupPart
	| NoticePart;

export interface StoredMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	at: string;
	status?: "running" | "complete";
	parts?: MessagePart[];
	/** 扇出的备选文本（TF-0094）：不含主回答，消息上的 chip 一击展开。 */
	variants?: string[];
}

export type AssistantRunEvent =
	| { type: "delta"; text: string; messageId: string }
	| { type: "parts"; parts: MessagePart[]; messageId: string }
	| { type: "done"; message: StoredMessage; messageId: string }
	| { type: "error"; message: string; messageId?: string };

export type ChatRunEvent =
	| AssistantRunEvent
	| { type: "user"; message: StoredMessage }
	| { type: "turn_started"; messageId: string }
	| { type: "notice_delivered"; count: number; messageId: string };

export type PermissionMode = "default" | "plan" | "acceptEdits";

export interface ThreadMeta {
	id: string;
	title: string;
	createdAt: string;
	status: "idle" | "running";
	permissionMode: PermissionMode;
	archived?: boolean;
	/** 分叉/重跑计数（TF-0092/0095）：锚点消息 id → 次数。 */
	forks?: Record<string, number>;
	/** 分叉血统（TF-0093）：本线程由哪个线程的哪条消息分叉而来。 */
	forkOf?: {
		sourceThreadId: string;
		sourceTitle: string;
		anchorMessageId: string;
		inheritedMessages: number;
		at: string;
		agentContextPlan?: {
			provider: "claude";
			mode: "fork-session";
			sourceThreadId: string;
			sourceSessionId: string;
			sourceFootprintSeq: number;
		};
	};
	forkInheritance?: {
		transcriptInherited: true;
		agentContextInherited: boolean | null;
		premiseInherited: boolean | null;
		observedAt?: string;
		provider?: string;
	};
	/** 最近一轮实际使用的 provider 与读集可观测性；从未运行过的线程没有。 */
	lastRun?: {
		provider: string;
		readObservability: "footprint" | "unobservable";
		at: string;
	};
	/** 准备恢复笔记（TF-0097）：离开时 agent 起草，返回时呈现为有序叙事。 */
	resumeNote?: ResumeNote;
	/**
	 * 收养身份快照（TF-0200）：收养时挂在被归档的源线程上。存在即表示本线程
	 * 是被「以分支为主线」归档的源线程——反转手势可用；普通手动归档没有此字段。
	 */
	adoptSnapshot?: { id: string; adoptedThreadId: string; at: string };
}

export interface Suggestion {
	text: string;
	kind: "option" | "question" | "next-step" | "diverge";
}

export interface DecisionPoint {
	messageId: string;
	kind: "fork" | "variant";
	count: number;
	preview: string;
}

export interface ParkedItem {
	id: string;
	kind: "draft";
	text: string;
	parkedAt: string;
}

/** Stable empty message collection shared by selectors and stream reducers. */
export const EMPTY: StoredMessage[] = [];
