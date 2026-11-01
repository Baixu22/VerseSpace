import type { Blackboard } from "../../blackboard";

/**
 * MCP 工具的形状与体积预算（TF-0211；模块目录化见 AGENTS.md「代码组织规则」）。
 *
 * 一条工具 = 名字 + 描述 + JSON Schema + 一个只读的 `run`。`run` 只回答
 * 「账本里有什么」，不暴露任何编排动作（不建线程、不派发、不裁决）。
 */

/** 响应默认体积上限（字符）。 */
export const DEFAULT_TRUNCATION_CHARS = 2000;

/** 截断到 max 字符，并标注被截掉的部分，让调用方知道有东西没展开。 */
export function truncate(text: string, max = DEFAULT_TRUNCATION_CHARS): string {
	if (text.length <= max) {
		return text;
	}
	const marker = `\n…[已截断，剩余 ${text.length - max} 字符]`;
	return text.slice(0, max - marker.length) + marker;
}

/** 把任意参数收敛成 1..100 的整数 limit（缺省用 fallback）。 */
export function limitOf(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.max(1, Math.min(100, Math.floor(value)));
	}
	return fallback;
}

export interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	run(params: Record<string, unknown>, bb: Blackboard): Promise<string>;
}
