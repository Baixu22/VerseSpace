/**
 * 安静的决策账本（TF-0095）。
 *
 * 自动填充：账本条目完全从既有事实推导——meta.forks（分叉与重跑计数，
 * 与 TF-0092 的信号同源）和消息上的扇出备选（TF-0094）。不新增任何
 * 记录负担。
 *
 * 安静：无分歧时账本为空——UI 对空账本完全不渲染（不是显示一个空的
 * 折叠条，而是根本不存在）。
 */

import type { StoredMessage, ThreadMeta } from "./threads";

export interface DecisionPoint {
	/** 分歧发生在哪条消息上。 */
	messageId: string;
	/** 分歧类型：fork = 从这条消息分叉/重跑过，variant = 这条回答有备选。 */
	kind: "fork" | "variant";
	/** 这条消息上出现的路径数（重跑/分叉次数或备选条数）。 */
	count: number;
	/** 消息摘要（账本列表里的一行预览）。 */
	preview: string;
}

/** 从消息序列与线程 meta 收集决策点（按消息顺序）。 */
export function collectDecisionPoints(
	messages: StoredMessage[],
	meta: Pick<ThreadMeta, "forks">,
): DecisionPoint[] {
	const byId = new Map(messages.map((m) => [m.id, m]));
	const points: DecisionPoint[] = [];
	for (const message of messages) {
		const forkCount = meta.forks?.[message.id] ?? 0;
		if (forkCount > 0) {
			points.push({
				messageId: message.id,
				kind: "fork",
				count: forkCount,
				preview: preview(message),
			});
		}
		const variantCount = message.variants?.length ?? 0;
		if (variantCount > 0) {
			points.push({
				messageId: message.id,
				kind: "variant",
				count: variantCount,
				preview: preview(message),
			});
		}
	}
	// forks 里可能指向已被 reload 截掉的消息：找不到消息体的锚点仍是一条
	// 分歧记录（它确实发生过），preview 降级为锚点 id。
	for (const [anchorId, count] of Object.entries(meta.forks ?? {})) {
		if (count > 0 && !byId.has(anchorId)) {
			points.push({
				messageId: anchorId,
				kind: "fork",
				count,
				preview: `（消息已不在当前记录中：${anchorId}）`,
			});
		}
	}
	return points;
}

function preview(message: StoredMessage, max = 48): string {
	const text = message.text.replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
