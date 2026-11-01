/**
 * 会话延续性（session continuity）的形状。
 *
 * 这是**投影**，不是状态机：每个字段都能回指一条已经落盘的事实（消息、
 * 线程事件、通知记录），推导过程不写盘、不调模型、不下裁决。会话是否还能
 * 被信任继续，由调用者读这几个事实自己判断；这里只保证「同一批事实只有
 * 一种读法」，且缺失的事实显式记为 unknown，不用相邻事实补齐（ADR-0026
 * 的同一纪律）。
 */

/** 一次被记录下来的回合中断（进程重启、宿主退出等）。 */
export interface ContinuityInterruption {
	/** 观察到中断的时刻（线程事件的时间戳）。 */
	at: string;
	/** 指向 `thread.turn_interrupted` 事件的身份，供恢复卡与 CLI 溯源。 */
	eventId: string | null;
	/** 中断时刻的消息条数；旧日志没有该字段时为 null。 */
	messageCount: number | null;
	/** 中断原因，当前生产者为 `host-restarted`。 */
	reason: string;
	/** 中断之后出现了助手消息 = 这条车道回来过并报了结果。 */
	recovered: boolean;
}

/** 推导所需的事实；每一项都来自一个写者，推导本身不产生新事实。 */
export interface ContinuityFacts {
	threadId: string;
	title: string;
	archived: boolean;
	createdAt: string;
	/** 最近一轮实际使用的 provider；从未运行过时为绑定的 provider，再没有则 null。 */
	lane: string | null;
	/** 该车道的 provider 会话身份（claude --session-id / codex thread id），HTTP 车道为 null。 */
	providerSessionId: string | null;
	/** 下一轮能否用 --resume / thread/resume 接上同一 provider 会话。 */
	resumable: boolean;
	lineage: {
		forkedFrom: string | null;
		promotedAs: string | null;
		adoptedSnapshot: string | null;
	};
	/** 写入 meta 的运行状态；`running` 在没有活进程时也是事实（它表示没被收尾）。 */
	status: "idle" | "running";
	messages: {
		total: number;
		assistant: number;
		lastAt: string | null;
		lastRole: "user" | "assistant" | null;
	};
	interruptions: ContinuityInterruption[];
	/** 仍在本线程通知队列里、尚未投递的前提通知条数。 */
	pendingNotices: number;
	/** 上述通知涉及的路径（去重）。 */
	pendingPaths: string[];
	/** 已投递的前提通知次数（`premise_notice_delivered`）。 */
	deliveredNotices: number;
	now: string;
}

/**
 * `intact` 只代表「没有观察到需要人处理的事实」，不是「已证明正确」；
 * `review` 表示有一条具体事实需要人看一眼；`unknown` 表示推导材料本身
 * 不够，不能把沉默读成健康。
 */
export type ContinuityState = "intact" | "review" | "unknown";

export interface SessionContinuity {
	threadId: string;
	title: string;
	archived: boolean;
	identity: {
		lane: string | null;
		providerSessionId: string | null;
		resumable: boolean;
		lineage: ContinuityFacts["lineage"];
	};
	turns: {
		completed: number;
		lastAt: string | null;
		/** 最新一条消息是人类的：没有助手消息回答它。 */
		open: boolean;
		interruptions: ContinuityInterruption[];
	};
	delivery: {
		pendingNotices: number;
		pendingPaths: string[];
		deliveredNotices: number;
	};
	state: ContinuityState;
	/** 为什么需要人看一眼（state = review 时非空）。 */
	because: string[];
	/** 材料不够的地方（state = unknown 时非空）。 */
	unknowns: string[];
	/** 可核对的身份：中断事件 id、失败引用等。 */
	refs: string[];
	readAt: string;
}
