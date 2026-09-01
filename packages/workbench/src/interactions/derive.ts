/**
 * PROV → 交互事件的派生（纯函数，无 IO）。
 *
 * 复用 R1 足迹的 PROV 语义：used（读了什么）映射为 selection——
 * 「触碰」是兴趣信号但没改变内容；generated（写了什么）映射为 edit——
 * 改动是更强的兴趣信号（DOI 权重更高）。
 */

import type { FootprintEntry, FootprintUsed } from "../blackboard/sessions";
import type { ContentType, InteractionEvent } from "./types";

const EXT_RE = /\.[A-Za-z0-9]+$/;

/** 有扩展名按文件计，否则按目录计（symbol 由交互层上报时显式标注）。 */
export function contentTypeOf(path: string): ContentType {
	return EXT_RE.test(path) ? "file" : "directory";
}

/** selection 的变化量：读取范围的行数（R2 层 2 的 span）；未知为 0。 */
export function deltaOfSelection(used: FootprintUsed): number {
	if (!used.span) {
		return 0;
	}
	const start = Math.max(1, used.span.start);
	const end = Math.max(start, used.span.end);
	return end - start + 1;
}

/**
 * 把一条足迹活动派生为交互事件序列。
 * 每条 used / generated 路径各派发一条，origin 统一为写者 id（按写者分组）。
 */
export function deriveInteractions(
	entry: FootprintEntry,
	origin: string,
): InteractionEvent[] {
	const events: InteractionEvent[] = [];
	for (const used of entry.used) {
		events.push({
			time: entry.timestamp,
			kind: "selection",
			origin,
			contentType: contentTypeOf(used.path),
			handle: used.path,
			delta: deltaOfSelection(used),
		});
	}
	for (const generated of entry.generated) {
		events.push({
			time: entry.timestamp,
			kind: "edit",
			origin,
			contentType: contentTypeOf(generated.path),
			handle: generated.path,
			// 工具调用参数不携带行数变化，按一次改动计（最小正信号）
			delta: 1,
		});
	}
	return events;
}
