import type {
	ContinuityInterruption,
	ContinuityState,
} from "../continuity/types";
import type { FactRow } from "./types";

/**
 * 恢复卡上的「会话被切断」行（TF-0323 判据 / TF-0324 落地）。
 *
 * 判据先于实现，且写成可执行的形式——UI 与卡片测试直接引用这里，不在文档里
 * 另说一遍。规则只有四条：
 *
 * 1. **健康不占空间。** `intact` 不产生任何行：没有观察到需要人处理的断点，
 *    卡片就不该因为「检查过」而多一块。
 * 2. **断点恰好一行。** 一条未恢复的中断 = 一行，`refs` 逐条指向
 *    `event:<id>`（证据接口可直接打开）。已恢复的中断不进卡片：记录留在账本
 *    里，但不再占注意力（ADR-0027 的恢复判据：中断之后有助手消息即回来过）。
 * 3. **积压不进事实区。** 未投递的前提通知是全局投递积压（真实账本上 30 条
 *    会话里 20 条同时带积压），并进行区会把真正的断点淹掉；它只作为卡片头部
 *    的一个计数，与 ADR-0027 里 CLI 的 `~` 是同一维度。
 * 4. **断点行先于一切、且不被折叠。** 同一条会话既有断点又有积压时，断点行
 *    排在事实区最前并钉在预览之外（`pinnedFacts`），其余行照旧按
 *    `factsPreviewCount` 折叠。断点永远看得见，文件事实才折叠。
 *
 * 卡片上不做的事（与 ADR-0027 一致）：不重跑那一轮、不重投通知、不归档线程、
 * 不把 `review` 变成任何动作。这一行只是「有一条没被回答的中断」这个事实。
 */

/** 卡片头部的投递计数：与事实行分开，不参与折叠。 */
export interface ContinuityDeliveryBadge {
	pendingNotices: number;
}

export interface ContinuityCardProjection {
	state: ContinuityState;
	/** 要渲染的事实行（intact / 无未恢复中断时为空）。 */
	rows: FactRow[];
	/** 头部积压计数；0 表示不显示徽标。 */
	delivery: ContinuityDeliveryBadge;
}

function compact(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 一条中断行的 refs：事件 id 带上 `event:` 前缀，证据接口按前缀解析。
 * 没有事件 id 的记录（旧日志）没有可核对来源，行仍显示但不伪造引用。
 */
function interruptionRefs(interruption: ContinuityInterruption): string[] {
	return interruption.eventId ? [`event:${interruption.eventId}`] : [];
}

function interruptionRow(interruption: ContinuityInterruption): FactRow {
	const count =
		interruption.messageCount === null
			? "条数未记录"
			: `当时 ${interruption.messageCount} 条消息`;
	// 没有事件身份的旧记录仍然是一条事实，只是没有可展开的来源——行照常显示，
	// refs 留空而不是伪造一个引用（同一纪律：缺失的事实不冒充已知）。
	return {
		path: "会话回合被切断",
		summary: compact(
			`${interruption.at} 中断（${interruption.reason}，${count}），之后没有助手回复`,
			120,
		),
		refs: interruptionRefs(interruption),
		source: "interruption",
	};
}

/**
 * 把延续性读数折成恢复卡的增量。纯函数：同一份读数永远得到同一张卡。
 *
 * `pendingNotices` 只数不回指路径：路径已经由 CLI 与 MCP 的 `~` 维度列出，
 * 卡片上多一份路径列表就是同一事实的第三个副本。
 */
export function continuityCardRows(input: {
	state: ContinuityState;
	interruptions: readonly ContinuityInterruption[];
	pendingNotices: number;
}): ContinuityCardProjection {
	const delivery: ContinuityDeliveryBadge = {
		pendingNotices: Math.max(0, input.pendingNotices),
	};
	if (input.state !== "review") {
		// intact / unknown 不新增行：unknown 的材料缺口由 CLI 与 MCP 报告，
		// 卡片只在有具体待办事实时说话（健康与不确定都不占注意力）。
		return { state: input.state, rows: [], delivery };
	}
	const rows: FactRow[] = [];
	for (const interruption of input.interruptions) {
		if (interruption.recovered) continue;
		rows.push(interruptionRow(interruption));
	}
	// 最新的断点排最前：人在卡片上先看到「最近一次被切断」。
	rows.sort((a, b) => (a.summary < b.summary ? 1 : -1));
	return { state: input.state, rows, delivery };
}
