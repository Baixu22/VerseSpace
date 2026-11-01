import type {
	ContinuityFacts,
	ContinuityInterruption,
	SessionContinuity,
} from "./types";

/** 需要 provider 会话身份的本地 CLI 车道；HTTP 车道按消息文本重放，本就没有上游会话。 */
const PROVIDER_SESSION_LANES = new Set(["claude", "codex"]);

function interruptionLine(interruption: ContinuityInterruption): string {
	const count =
		interruption.messageCount === null
			? "消息条数未记录"
			: `当时 ${interruption.messageCount} 条消息`;
	return `回合在 ${interruption.at} 中断（${interruption.reason}，${count}），之后没有助手回复`;
}

/**
 * 把一批事实折成一份会话延续性读数。
 *
 * 纯函数：同样的输入永远得到同样的输出，不读时钟（`now` 由调用者给），
 * 不写盘，不调模型。三条纪律：
 *
 * 1. 只报事实允许的结论——「没有观察到问题」不等于「已通过」。
 * 2. 需要人看的事实进 `because`，材料不够进 `unknowns`，两者分开列。
 * 3. 历史中断只要之后有助手消息回答过，就不再需要人处理（仍然留在列表里）。
 * 4. 未投递的前提通知**不并入** state：它是一条全局投递积压，同一个后端在
 *    几十条旧会话上是同一个事实，混进 state 会把「会话断了」淹掉。它照常
 *    出现在 delivery 里，由展示层单独标一个维度。
 */
export function deriveSessionContinuity(
	facts: ContinuityFacts,
): SessionContinuity {
	const because: string[] = [];
	const unknowns: string[] = [];
	const refs: string[] = [];

	const open = facts.messages.lastRole === "user";
	for (const interruption of facts.interruptions) {
		if (interruption.eventId) {
			refs.push(interruption.eventId);
		}
		if (interruption.messageCount === null) {
			unknowns.push("有中断事件没有记录当时的消息条数");
		}
		if (!interruption.recovered) {
			because.push(interruptionLine(interruption));
		}
	}

	if (open) {
		const unanswered = facts.interruptions.find(
			(interruption) => !interruption.recovered,
		);
		// 未回复的人类消息已经由中断行说明原因时，不再重复计一条。
		if (!unanswered) {
			because.push("最后一条是人类消息，没有助手回复");
		}
	}

	if (facts.status === "running") {
		unknowns.push("线程仍标记为运行中：这一轮是否结束没有被记录");
	}

	if (
		facts.lane !== null &&
		PROVIDER_SESSION_LANES.has(facts.lane) &&
		facts.messages.total > 0 &&
		facts.providerSessionId === null
	) {
		unknowns.push("缺少 provider 会话 id：下一轮能否接上同一会话无法确认");
	}

	if (facts.messages.total > 0 && facts.messages.lastAt === null) {
		unknowns.push("有消息但没有记录最近一条的时间");
	}

	const state =
		because.length > 0 ? "review" : unknowns.length > 0 ? "unknown" : "intact";

	return {
		threadId: facts.threadId,
		title: facts.title,
		archived: facts.archived,
		identity: {
			lane: facts.lane,
			providerSessionId: facts.providerSessionId,
			resumable: facts.resumable,
			lineage: facts.lineage,
		},
		turns: {
			completed: facts.messages.assistant,
			lastAt: facts.messages.lastAt,
			open,
			interruptions: facts.interruptions,
		},
		delivery: {
			pendingNotices: facts.pendingNotices,
			pendingPaths: facts.pendingPaths,
			deliveredNotices: facts.deliveredNotices,
		},
		state,
		because,
		unknowns,
		refs,
		readAt: facts.now,
	};
}

/** 一组会话的汇总：只数事实，不给出「整体健康」之类无法核对的总分。 */
export interface ContinuitySummary {
	total: number;
	intact: number;
	review: number;
	unknown: number;
	/** 仍有未投递前提通知的会话数；与 state 是两个维度，不互相覆盖。 */
	pending: number;
	/** 需要人看一眼的会话 id，按 id 排序。 */
	reviewThreads: string[];
	/** 材料不够的会话 id，按 id 排序。 */
	unknownThreads: string[];
	/** 有未投递通知的会话 id，按 id 排序。 */
	pendingThreads: string[];
}

export function summarizeContinuity(
	rows: readonly SessionContinuity[],
): ContinuitySummary {
	const reviewThreads = rows
		.filter((row) => row.state === "review")
		.map((row) => row.threadId)
		.sort();
	const unknownThreads = rows
		.filter((row) => row.state === "unknown")
		.map((row) => row.threadId)
		.sort();
	const pendingThreads = rows
		.filter((row) => row.delivery.pendingNotices > 0)
		.map((row) => row.threadId)
		.sort();
	return {
		total: rows.length,
		intact: rows.filter((row) => row.state === "intact").length,
		review: reviewThreads.length,
		unknown: unknownThreads.length,
		pending: pendingThreads.length,
		reviewThreads,
		unknownThreads,
		pendingThreads,
	};
}
