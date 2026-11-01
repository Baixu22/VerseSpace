/**
 * MCP 工具目录（TF-0211，第六个工具 TF-0326/TF-0328）。
 *
 * 六条只读通道：前提失效查询、足迹读取、恢复卡、裁决队列、通知投递、会话延续性。
 * 只回答「账本里有什么」，不暴露任何编排动作（不建线程、不派发、不裁决、
 * 不重跑、不重投）。每个工具的响应都过 `truncate`，默认 ≤2000 字符——MCP
 * 客户端会把文本直接塞进模型上下文，体积不设上限会让一次查询把预算吃光。
 *
 * 名字、描述、schema、截断预算、只读属性都**只在这张表里出现一次**
 * （TF-0328）：新工具进目录必须同时加进 `MCP_TOOL_NAMES`，表面漂移测试
 * 用同一张表断言条数与逐条可调用。
 */
import { continuityTool } from "./continuity";
import { footprintsTool } from "./footprints";
import { noticesTool } from "./notices";
import { premisesTool } from "./premises";
import { resumeCardsTool } from "./resume-cards";
import { tribunalTool } from "./tribunal";
import type { McpTool } from "./types";

export type { McpTool } from "./types";
export { DEFAULT_TRUNCATION_CHARS, limitOf, truncate } from "./types";

export const MCP_TOOLS: McpTool[] = [
	premisesTool,
	footprintsTool,
	resumeCardsTool,
	tribunalTool,
	noticesTool,
	continuityTool,
];

/**
 * 工具目录的名字表（唯一来源）。表面漂移测试断言 `MCP_TOOLS` 的顺序与名字
 * 跟这张表一致——工具删了、改名了或顺序变了，测试就红，而不是悄悄少一条。
 */
export const MCP_TOOL_NAMES = [
	"premises",
	"footprints",
	"resume_cards",
	"tribunal",
	"notices",
	"continuity",
] as const;

/** 按名字找工具；找不到返回 undefined。 */
export function findMcpTool(name: string): McpTool | undefined {
	return MCP_TOOLS.find((tool) => tool.name === name);
}
