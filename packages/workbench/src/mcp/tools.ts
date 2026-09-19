/**
 * MCP 工具目录（TF-0211）。
 *
 * 五条只读通道：前提失效查询、足迹读取、恢复卡、裁决队列、通知投递。
 * 只回答「账本里有什么」，不暴露任何编排动作（不建线程、不派发、不裁决）。
 * 每个工具的响应都过 `truncate`，默认 ≤2000 字符——MCP 客户端会把文本
 * 直接塞进模型上下文，体积不设上限会让一次查询把预算吃光。
 */

import type { Blackboard } from "../blackboard";
import { collectRestoreView } from "../chat/restore-view";
import { ChatThreads } from "../chat/threads";
import { pendingPremiseNotices } from "../runtime/delivery";
import type { WorkbenchEvent } from "../types/event";

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
function limitOf(value: unknown, fallback: number): number {
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

/** 最近足迹事件里可展示的字段（其余 payload 不暴露给外部）。 */
interface FootprintView {
	at: string;
	writer: string;
	tool: string;
	used: string[];
	generated: string[];
}

function toFootprintView(event: WorkbenchEvent): FootprintView {
	const payload = event.payload as Record<string, unknown> & {
		writer?: string;
		facets?: { tool?: string };
		used?: Array<{ path?: string }>;
		generated?: Array<{ path?: string }>;
	};
	return {
		at: event.timestamp,
		writer: payload.writer ?? "?",
		tool: payload.facets?.tool ?? "?",
		used: (payload.used ?? []).map((u) => u.path ?? "?"),
		generated: (payload.generated ?? []).map((g) => g.path ?? "?"),
	};
}

/**
 * 五个工具的实现。每个 run 只做读操作，返回纯文本（已截断）。
 */
export const MCP_TOOLS: McpTool[] = [
	{
		name: "premises",
		description:
			"查询待投递的前提失效通知：哪些写者读过的文件已被其他写者修改（R2 检测结果）。只读，不触发投递。",
		inputSchema: {
			type: "object",
			properties: {
				writer: {
					type: "string",
					description: "按写者 id 过滤（如线程 id 或 git-main）。",
				},
				limit: {
					type: "integer",
					description: "最多返回的通知数，默认 10，最大 100。",
				},
			},
		},
		async run(params, bb) {
			const pending = await pendingPremiseNotices(bb);
			const writer =
				typeof params.writer === "string" && params.writer
					? params.writer
					: undefined;
			const filtered = writer
				? pending.filter((n) => n.writerId === writer)
				: pending;
			const top = filtered.slice(0, limitOf(params.limit, 10));
			if (top.length === 0) {
				return "没有待投递的前提失效通知。";
			}
			const lines = top.map((notice) => {
				const claims = notice.claims
					.map(
						(claim) =>
							`${claim.path} ${(claim.observedVersion ?? "?").slice(0, 8)} → ${(claim.currentVersion ?? "?").slice(0, 8)}${claim.diff ? "（有 diff）" : ""}`,
					)
					.join("；");
				return `- writer=${notice.writerId} notice=${notice.noticeId}\n  ${claims}`;
			});
			return truncate(
				`待投递前提失效通知 ${filtered.length} 条（展示 ${top.length}）：\n${lines.join("\n")}`,
			);
		},
	},
	{
		name: "footprints",
		description:
			"读取最近记录的足迹事件：agent 实际读/写了哪些文件（足迹账本）。只读。",
		inputSchema: {
			type: "object",
			properties: {
				writer: {
					type: "string",
					description: "按写者 id 过滤。",
				},
				limit: {
					type: "integer",
					description: "最多返回的事件数，默认 20，最大 100。",
				},
			},
		},
		async run(params, bb) {
			const events = await bb.events.query({
				type: "footprint",
				limit: limitOf(params.limit, 20),
			});
			const writer =
				typeof params.writer === "string" && params.writer
					? params.writer
					: undefined;
			// query 取尾部（时间正序），倒序后新的在前。
			const views = [...events]
				.reverse()
				.map(toFootprintView)
				.filter((v) => writer === undefined || v.writer === writer);
			if (views.length === 0) {
				return "没有足迹事件。";
			}
			const lines = views.map(
				(v) =>
					`- ${v.at} writer=${v.writer} tool=${v.tool} used=[${v.used.join(",")}] generated=[${v.generated.join(",")}]`,
			);
			return truncate(`最近足迹 ${views.length} 条：\n${lines.join("\n")}`);
		},
	},
	{
		name: "resume_cards",
		description:
			"读取恢复卡：线程在离开期间发生了什么变化（读集 diff、分支动静、失效前提、恢复笔记）。只读。",
		inputSchema: {
			type: "object",
			properties: {
				threadId: {
					type: "string",
					description: "指定线程 id；不传则列出所有带恢复笔记的线程。",
				},
				limit: {
					type: "integer",
					description: "不传 threadId 时最多列出的线程数，默认 10。",
				},
			},
		},
		async run(params, bb) {
			const chat = new ChatThreads(bb);
			const threadId =
				typeof params.threadId === "string" && params.threadId
					? params.threadId
					: undefined;
			if (threadId) {
				const view = await collectRestoreView(bb, chat, threadId);
				if (!view.resumeCard) {
					return `线程 ${threadId} 没有恢复卡。`;
				}
				const card = view.resumeCard;
				const beats = (view.resumeNote?.beats ?? [])
					.map((beat) => `${beat.kind}:${beat.text}`)
					.join(" | ");
				const facts = card.facts
					.slice(0, card.factsPreviewCount)
					.map(
						(fact) => `${fact.path}${fact.summary ? ` ${fact.summary}` : ""}`,
					)
					.join("；");
				const coverage = `${card.coverage.status}（${card.coverage.compared}/${card.coverage.comparable} 可比）`;
				return truncate(
					[
						`线程 ${threadId} 恢复卡：`,
						`- 覆盖：${coverage}`,
						`- 恢复增量：${view.resumeDelta}`,
						`- 恢复笔记：${beats || "无"}`,
						`- 事实：${facts || "无"}`,
						`- 已忽略：${card.dismissed ? "是" : "否"}；注入：${card.inject ? "是" : "否"}`,
					].join("\n"),
				);
			}
			const metas = await chat.list();
			const withNotes = metas.filter((meta) => meta.resumeNote);
			const top = withNotes.slice(0, limitOf(params.limit, 10));
			if (top.length === 0) {
				return "没有带恢复笔记的线程。";
			}
			return truncate(
				`有恢复笔记的线程 ${withNotes.length} 个（展示 ${top.length}）：\n` +
					top
						.map((meta) => `- ${meta.id}${meta.title ? ` ${meta.title}` : ""}`)
						.join("\n"),
			);
		},
	},
	{
		name: "tribunal",
		description:
			"列出裁决队列（R3）：等待人类决策的条目（工位阻塞、前提冲突等）。只读，不裁决。",
		inputSchema: {
			type: "object",
			properties: {
				includeResolved: {
					type: "boolean",
					description: "是否包含已解决条目，默认 false。",
				},
				limit: {
					type: "integer",
					description: "最多返回的条目数，默认 10，最大 100。",
				},
			},
		},
		async run(params, bb) {
			const items = await bb.tribunal.list({
				includeResolved: params.includeResolved === true,
			});
			const top = items.slice(0, limitOf(params.limit, 10));
			if (top.length === 0) {
				return "裁决队列为空。";
			}
			const lines = top.map(
				(item) =>
					`- ${item.id} [${item.state}] ${item.kind} score=${item.score.toFixed(3)} priority=${item.priority} cause=${item.causeKey ?? ""} subject=${item.subject}`,
			);
			return truncate(
				`裁决队列 ${items.length} 条（展示 ${top.length}）：\n${lines.join("\n")}`,
			);
		},
	},
	{
		name: "notices",
		description:
			"读取通知投递情况：最近成功投递的前提失效通知与仍待投递的数量。只读。",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "integer",
					description: "最多返回的投递记录数，默认 10，最大 100。",
				},
			},
		},
		async run(params, bb) {
			const delivered = await bb.events.query({
				type: "premise_notice_delivered",
				limit: limitOf(params.limit, 10),
			});
			const pending = await pendingPremiseNotices(bb);
			const lines = [...delivered].reverse().map((event) => {
				const payload = event.payload as {
					writer?: string;
					count?: number;
					readObservability?: boolean | string;
				};
				return `- ${event.timestamp} writer=${payload.writer ?? "?"} count=${payload.count ?? 0} observable=${String(payload.readObservability ?? "?")}`;
			});
			return truncate(
				`待投递 ${pending.length} 条；最近投递 ${delivered.length} 条：\n${lines.join("\n")}`,
			);
		},
	},
];

/** 按名字找工具；找不到返回 undefined。 */
export function findMcpTool(name: string): McpTool | undefined {
	return MCP_TOOLS.find((tool) => tool.name === name);
}
