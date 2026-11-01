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
	/**
	 * 中断原因，是**可观测的**代码路径名，不是猜测：
	 * - `host-restarted`：启动清扫发现 `status` 仍停在 `running`（宿主进程在回合
	 *   中途消失）。生产者是 `threads.ts` 的 `reconcileRunningOnStartup`。
	 * - `unknown`：事件没有记录原因（旧日志）。不就近归入最接近的类别。
	 */
	reason: string;
	/**
	 * 用户主动终止了这一轮（`thread.turn_cancelled`，阶段三 TF-0330）。
	 * 与中断是两件事：中断是「没有终结观察的消失」，终止是「有人按了停」。
	 */
	userStopped: boolean;
	/** 中断之后出现了助手消息 = 这条车道回来过并报了结果。 */
	recovered: boolean;
}

/** 一次被记录下来的用户主动终止（阶段三 TF-0330）。 */
export interface ContinuityCancellation {
	/** 终止观察的时刻。 */
	at: string;
	/** 指向 `thread.turn_cancelled` 事件的身份。 */
	eventId: string | null;
	/** 终止时的消息条数；缺该字段时为 null。 */
	messageCount: number | null;
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
	/** 用户主动终止的记录（`thread.turn_cancelled`）。 */
	cancellations: ContinuityCancellation[];
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

/**
 * 断点与积压的联合判读（TF-0331）。两维各自可核对，不合并成单一分数：
 * - `break-first`：存在需要人处理的具体事实（未恢复的中断，或没有回复的人类
 *   消息）——先看它。
 * - `backlog-only`：没有上述事实，只有未投递积压——积压是全局投递队列，不急。
 * - `neither`：两者都没有。
 *
 * 「断点」在这里指**需要人看一眼的具体事实**，不限于中断事件：一条没有回复的
 * 人类消息同样是待办（ADR-0027 的 `review`）。用 `because` 而不是只看中断，
 * 是为了不让「先看断点」与 state 互相矛盾。
 */
export type ContinuityPriority = "break-first" | "backlog-only" | "neither";

/**
 * 一条材料缺口。`pointer` 是**去哪里核对**，不是结论：
 * - `meta.status`：线程 meta 的 status 字段；
 * - `meta.claudeSessionId` / `meta.codexSessionId` / `meta.hasResumableSession`：
 *   该车道的 provider 会话身份字段；
 * - `event:<id>` / `eventType:<type>`：某条已落盘的事件。
 */
export interface ContinuityUnknown {
	text: string;
	pointer: string;
}

/** 把缺口折成一行文本（CLI / MCP 共用，带上可核对指针）。 */
export function unknownLine(unknown: ContinuityUnknown): string {
	return `${unknown.text}（可核对：${unknown.pointer}）`;
}

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
		/** 用户主动终止的记录（`thread.turn_cancelled`），与中断分开列。 */
		cancellations: ContinuityCancellation[];
	};
	delivery: {
		pendingNotices: number;
		pendingPaths: string[];
		deliveredNotices: number;
	};
	state: ContinuityState;
	/** 断点 × 积压的联合判读：只依赖已有两维事实，不新增采集（TF-0331）。 */
	priority: ContinuityPriority;
	/** 为什么需要人看一眼（state = review 时非空）。 */
	because: string[];
	/**
	 * 材料不够的地方（state = unknown 时非空）。每一条都带一个**可回指的字段或
	 * 事件**（TF-0334）：读不到的东西必须能指名去哪里看，而不是一句含糊的
	 * 「数据不足」。
	 */
	unknowns: ContinuityUnknown[];
	/** 可核对的身份：中断事件 id、失败引用等。 */
	refs: string[];
	readAt: string;
}
