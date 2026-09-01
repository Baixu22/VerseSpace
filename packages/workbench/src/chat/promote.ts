/**
 * 加法式晋升（TF-0092）。
 *
 * 每段对话从第 0 个事件起就是一个上下文，无名、无标题。晋升发生在**事后**，
 * 由已经会发生的事触发——绝不要求用户先声明任务，绝不要求用户命名或分类。
 *
 * ADR-0009 裁定不建「要不要 X」式提议 UI：晋升成本 B 实测 3ms、拆除 12ms，
 * 都远低于问一句的 K。所以信号命中就**直接晋升**（改标题这一层），撤销就是
 * 改回去——廉价可逆替代提议确认。
 *
 * 边界纪律：晋升只在**完成的轮次边界**评估（调用方保证），绝不在生成过程中。
 * 晋升后对话本身零变化：只写 meta 的标题与晋升记录，messages.jsonl 一个字节不动。
 */

import type { StoredMessage, ThreadMeta } from "./threads";

/** 默认（未命名）标题——与 threads.create 保持一致。 */
export const UNNAMED_TITLE = "新对话";

/** 会话跨过多少轮后晋升。轮数太少则随手一问也被命名（噪声），太多则命名来得太晚。8 轮 ≈ 一次真正的工作块。 */
export const PROMOTION_TURNS = 8;

/** 隔天以上的恢复：距上一条消息超过这么多小时视为「隔天」。 */
export const NEXT_DAY_RESUME_HOURS = 20;

/**
 * 触发信号——全部绑定到既有事件，没有一个是新仪式：
 *  - turns-crossed        会话跨过 N 轮
 *  - next-day-resume      隔天以上的恢复
 *  - second-fork          同一条消息上第二次分叉（含 reload）
 *  - repeated-test-failure 重复的测试失败（由足迹侧喂入，本层只定义形状）
 *  - commit               一次提交（由足迹侧喂入，本层只定义形状）
 */
export type PromotionSignal =
	| { kind: "turns-crossed"; turns: number }
	| { kind: "next-day-resume"; awayHours: number }
	| { kind: "second-fork"; atMessageId: string }
	| { kind: "repeated-test-failure"; count: number }
	| { kind: "commit"; ref: string };

export interface PromotionInput {
	/** 当前标题（未命名 = UNNAMED_TITLE）。 */
	title: string;
	/** 到本轮为止的用户轮数。 */
	userTurnCount: number;
	/** 本轮边界观测到的信号。 */
	signals: PromotionSignal[];
}

export interface PromotionVerdict {
	/** 是否晋升（直接做，不是提议）。 */
	promote: boolean;
	/** 命中的信号（记录进 meta，可观测）。 */
	signals: PromotionSignal[];
	/** 不晋升的原因（promote=false 时有值）。 */
	reason?: "already-named" | "no-signal";
}

/**
 * 纯函数判定：信号命中任一即晋升，已命名的对话不再重复晋升
 * （命名是用户可改写的一层，覆盖它等于偷走用户的编辑）。
 */
export function evaluatePromotion(input: PromotionInput): PromotionVerdict {
	if (input.title !== UNNAMED_TITLE) {
		return { promote: false, signals: [], reason: "already-named" };
	}
	if (input.signals.length === 0) {
		return { promote: false, signals: [], reason: "no-signal" };
	}
	return { promote: true, signals: input.signals };
}

/**
 * 从对话内容推导标题——确定性、零 AI 调用：第一条用户消息裁到 24 字。
 * 这是廉价代理，不是摘要；用户随时可以改（撤销 = 改回去）。
 */
export function deriveTitle(messages: StoredMessage[]): string {
	const first = messages.find((m) => m.role === "user");
	const text = first?.text.trim() ?? "";
	if (!text) {
		return UNNAMED_TITLE;
	}
	return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

/** 从消息列表数用户轮数。 */
export function countUserTurns(messages: StoredMessage[]): number {
	return messages.filter((m) => m.role === "user").length;
}

/** 距上一条消息的小时数；没有任何消息时返回 0（首轮不算恢复）。 */
export function hoursSinceLastMessage(
	messages: StoredMessage[],
	now: Date = new Date(),
): number {
	const last = messages.at(-1);
	if (!last) {
		return 0;
	}
	const then = new Date(last.at).getTime();
	if (Number.isNaN(then)) {
		return 0;
	}
	return Math.max(0, (now.getTime() - then) / 3_600_000);
}

/**
 * 收集本轮边界上可从线程自身推导的信号（轮次跨越 / 隔天恢复）。
 * second-fork 由 reload/fork 路径写入 meta.forks 后经入参传入；
 * repeated-test-failure 与 commit 由足迹侧喂入，这里不推导。
 */
export function collectSignals(
	messages: StoredMessage[],
	opts: { extraSignals?: PromotionSignal[]; now?: Date } = {},
): PromotionSignal[] {
	const signals: PromotionSignal[] = [];
	const turns = countUserTurns(messages);
	if (turns >= PROMOTION_TURNS) {
		signals.push({ kind: "turns-crossed", turns });
	}
	const away = hoursSinceLastMessage(messages, opts.now);
	if (away >= NEXT_DAY_RESUME_HOURS) {
		signals.push({
			kind: "next-day-resume",
			awayHours: Math.round(away * 10) / 10,
		});
	}
	signals.push(...(opts.extraSignals ?? []));
	return signals;
}

/** 晋升写入 meta 的记录（可观测，不参与任何自动动作）。 */
export interface PromotionRecord {
	at: string;
	signals: PromotionSignal[];
	title: string;
}

/** 计算晋升后的 meta 补丁（纯函数，调用方负责落盘）。 */
export function promotionPatch(
	messages: StoredMessage[],
	signals: PromotionSignal[],
	now: Date = new Date(),
): Pick<ThreadMeta, "title"> & { promotion: PromotionRecord } {
	const title = deriveTitle(messages);
	return {
		title,
		promotion: {
			at: now.toISOString(),
			signals,
			title,
		},
	};
}
