import type { ResumeNote } from "./resume-types";

export type MessagePart =
	| { type: "text"; text: string }
	| {
			type: "tool-call";
			toolCallId: string;
			toolName: string;
			args: unknown;
			result?: unknown;
	  };

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
	/** 准备恢复笔记（TF-0097）：离开时 agent 起草，返回时呈现为有序叙事。 */
	resumeNote?: ResumeNote;
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
