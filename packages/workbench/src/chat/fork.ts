/**
 * 追溯式分叉（TF-0093）。
 *
 * 每条消息都是隐式分叉点：分叉是一个手势（一次 POST，零仪式）——不要求
 * 标题、不要求类型、不弹任何对话框。结果是线程列表里的兄弟条目，原线程
 * 逐字节不变。
 *
 * 继承声明是硬要求（证据：ChatGPT 两个 bug 都犯过——继承太少，然后继承
 * 太多）。分叉继承且仅继承：锚点（含）之前的消息前缀；其余一切从新开始，
 * 由 ForkDeclaration 逐项声明，绝不静默决定。
 */

import type { StoredMessage, ThreadMeta } from "./threads";

/** 分叉血统，写进新线程 meta.forkOf（线程列表徽标的数据源）。 */
export interface ForkLineage {
	sourceThreadId: string;
	/** 分叉时刻源线程的标题（可观测快照，源线程后续改名不影响它）。 */
	sourceTitle: string;
	anchorMessageId: string;
	inheritedMessages: number;
	at: string;
}

/**
 * 一次分叉继承了什么、没继承什么——分叉响应携带，UI 负责呈现给用户。
 * 「fresh」字段为字面量 true：类型上强制每一条「不继承」都被显式声明。
 */
export interface ForkDeclaration {
	/** 继承：消息前缀（含锚点）的条数。 */
	inheritedMessages: number;
	/** 继承的终点（锚点消息本身）。 */
	anchor: { id: string; role: StoredMessage["role"]; at: string };
	/** 不继承 agent 会话：新线程下次运行铸造全新会话（上下文已分叉）。 */
	freshAgentSession: true;
	/** 不继承晋升记录（标题从继承前缀重新推导）。 */
	freshPromotion: true;
	/** 不继承源线程的分叉计数（血统记录在 forkOf，二者不同层）。 */
	freshForkCounts: true;
	/** 不继承归档状态（分叉条目始终出现在线程列表）。 */
	freshArchived: true;
}

export interface ForkOutcome {
	ok: boolean;
	thread?: ThreadMeta;
	declaration?: ForkDeclaration;
	reason?: string;
}

/**
 * 纯函数：按锚点切出继承前缀（含锚点本身——「在这条消息上分叉」即
 * 它之前的一切都算数，包括它）。
 */
export function forkSlice(
	messages: StoredMessage[],
	anchorMessageId: string,
):
	| { ok: true; inherited: StoredMessage[]; anchor: StoredMessage }
	| { ok: false } {
	const index = messages.findIndex((m) => m.id === anchorMessageId);
	if (index < 0) {
		return { ok: false };
	}
	return {
		ok: true,
		inherited: messages.slice(0, index + 1),
		anchor: messages[index]!,
	};
}

/** 计算继承声明（纯函数，调用方负责把它随分叉结果返回）。 */
export function buildForkDeclaration(
	anchor: StoredMessage,
	inheritedCount: number,
): ForkDeclaration {
	return {
		inheritedMessages: inheritedCount,
		anchor: { id: anchor.id, role: anchor.role, at: anchor.at },
		freshAgentSession: true,
		freshPromotion: true,
		freshForkCounts: true,
		freshArchived: true,
	};
}
