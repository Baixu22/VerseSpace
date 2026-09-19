import type {
	DecisionPoint,
	ParkedItem,
	StoredMessage,
	Suggestion,
	ThreadMeta,
} from "./message-types";
import type { ReadSetDiff, ResumeCardView, ResumeNote } from "./resume-types";
export interface ForkDeclaration {
	inheritedMessages: number;
	anchor: { id: string; role: string; at: string };
	transcriptInherited: true;
	agentContextInherited: boolean | null;
	premiseInherited: boolean | null;
	inheritanceObserved: boolean;
	agentContextPlan?: "fork-session";
	freshAgentSession: true;
	freshPromotion: true;
	freshForkCounts: true;
	freshArchived: true;
}

export interface ChatState {
	threads: ThreadMeta[];
	activeId: string | null;
	messages: Record<string, StoredMessage[]>;
	/** The thread with an in-flight run, if any. */
	runningThreadId: string | null;
	/** 最近一次分叉的继承声明（TF-0093）：切线程或手动关闭后消失。 */
	forkNotice: {
		text: string;
		threadId: string;
		anchorMessageId: string;
	} | null;
	/** 当前线程的系统提议下一步（TF-0095），随线程 GET 刷新。 */
	suggestions: Suggestion[];
	/** 当前线程的决策账本（TF-0095），无分歧时为空数组＝完全不渲染。 */
	decisionPoints: DecisionPoint[];
	/** 各线程的实时草稿镜像（TF-0096）：composer 文本随键入镜像到这里。 */
	drafts: Record<string, string>;
	/** 各线程的停放快照（TF-0096）：切换离开时收起的产物。 */
	parked: Record<string, ParkedItem[]>;
	/** 当前线程的恢复笔记（TF-0097）：离开时生成、返回时呈现。null = 无笔记。 */
	resumeNote: ResumeNote | null;
	/** 返回时检测『你不在时变了什么』（TF-0097）：离开后新增的消息条数。 */
	resumeDelta: number;
	/** R2′ restore-time read-set facts; null means no card or unknown baseline. */
	readSetDiff: ReadSetDiff | null;
	resumeCard: ResumeCardView | null;
	resumeCardDismissed: boolean;
	resumeCardRevealed: boolean;
	/**
	 * TF-0142 前提通知送达信号：本轮实际向 agent 送达了几条前提通知。
	 * `null` = 本会话还没有送过。送达是「交付了但看不到」的反面——用户
	 * 必须能看见 agent 被提醒过（2026-09-13 收尾 §4.3）。
	 */
	noticesDelivered: { count: number; at: string } | null;
	/**
	 * TF-0092 手动晋升手势是否可见。由服务端判定（无名且有内容），客户端只渲染
	 * ——不复制「无名」这个判断（2026-09-13 收尾 §4.4）。
	 */
	canPromote: boolean;
	init(): Promise<void>;
	createThread(): Promise<void>;
	switchThread(id: string): Promise<void>;
	send(text: string): Promise<void>;
	reload(): Promise<void>;
	fork(messageId: string): Promise<string | null>;
	dismissForkNotice(): void;
	setDraft(threadId: string, text: string): void;
	/** 切换离开时收起草稿：进停放快照，composer 清空（清场）。 */
	parkDraft(threadId: string, text: string): void;
	discardParked(threadId: string, itemId: string): void;
	clearParked(threadId: string): void;
	/** 确认恢复笔记（TF-0097）：置 confirmedAt，不阻塞。 */
	confirmResumeNote(): Promise<void>;
	/** 编辑恢复笔记的一个节拍（TF-0097）。 */
	editResumeBeat(index: number, text: string): Promise<void>;
	consumeResumeNote(surface: string): Promise<void>;
	dismissResumeCard(): Promise<void>;
	revealResumeCard(): void;
	recordResumeAction(action: string, label?: string): Promise<void>;
	/**
	 * TF-0199：恢复卡展示观测——渲染出带分支行的恢复卡时上报本次展示的
	 * 行标签（`branch:<threadId>`）。fit 指标 7 的分母，重复刷新由调用方
	 * 按恢复边界去重。
	 */
	reportResumeCardShown(branchRows: string[]): Promise<void>;
	/**
	 * TF-0200「以分支为主线」：收养一个分支线程使其成为主线——POST 到该
	 * 分支线程的 adopt 路由（threadId 是被收养的分支，不是当前活动线程），
	 * 成功后跳转到这条新主线。
	 */
	adoptBranch(threadId: string): Promise<void>;
	/** TF-0142：关掉送达提示（短暂可见后自动消失）。 */
	dismissNoticeDelivered(): void;
	/** TF-0092：手动晋升——一个手势给无名对话命名。 */
	promoteActive(): Promise<void>;
	cancel(): void;
	setPlanMode(enabled: boolean): Promise<void>;
	deleteThread(id: string): Promise<void>;
	setArchived(id: string, archived: boolean): Promise<void>;
	renameThread(id: string, title: string): Promise<void>;
	feedback(messageId: string, kind: "positive" | "negative"): Promise<void>;
}

export interface ThreadGetResponse {
	meta: ThreadMeta;
	messages: StoredMessage[];
	suggestions: Suggestion[];
	decisionPoints: DecisionPoint[];
	resumeNote: ResumeNote | null;
	/**
	 * 「你不在时变了什么」：服务端 `collectRestoreView` 用
	 * `chat/resume.ts` 的 `resumeDelta()` 算好随载荷下发，客户端直接读
	 * ——不再内联重算同一算式（2026-09-13 收尾 §5.6，单一来源）。
	 */
	resumeDelta: number;
	readSetDiff?: ReadSetDiff;
	resumeCard?: ResumeCardView | null;
	resumeCardDismissed?: boolean;
	canPromote?: boolean;
}
