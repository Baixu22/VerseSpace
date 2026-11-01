import {
	readAllSessionContinuity,
	readSessionContinuity,
	type SessionContinuity,
	unknownLine,
} from "../../chat/continuity";
import { limitOf, type McpTool, truncate } from "./types";

/**
 * `continuity`（TF-0326 / TF-0327）：会话延续性的只读面——第六个工具。
 *
 * 契约是 `chat/continuity` 三态读数与 `delivery` 的**子集**，不引入新判据：
 * 每个字段都能回指一条已落盘的事实（线程 meta、消息、`thread.turn_interrupted`
 * 事件、通知投递记录）。工具只回答「有没有一条没被回答的中断」，据此不产生任何
 * 动作——不重跑、不重投、不归档、不改线程（ADR-0027 的边界，ADR-0023 的只读面）。
 *
 * 返回是纯文本，且整段过 `truncate`：MCP 客户端会把文本直接塞进模型上下文。
 */

const STATE_LABEL: Record<SessionContinuity["state"], string> = {
	intact: "无待办观察",
	review: "需要人看一眼",
	unknown: "材料不足",
};

/** 联合判读（TF-0331）：断点与积压两维不合并成单一分数。 */
const PRIORITY_LABEL: Record<SessionContinuity["priority"], string> = {
	"break-first": "先看断点",
	"backlog-only": "只有投递积压",
	neither: "无待办",
};

/** 行首标记：`!` 断点 / `?` 材料不足 / `~` 仅投递积压 / `-` 无待办。 */
function flagOf(row: SessionContinuity): string {
	if (row.state === "review") return "!";
	if (row.state === "unknown") return "?";
	if (row.delivery.pendingNotices > 0) return "~";
	return "-";
}

/** 标题截到 60 字符：够定位会话，又不让一行吃掉整段预算。 */
function titleOf(row: SessionContinuity): string {
	const title = row.title.trim();
	if (!title) return "";
	return title.length > 60 ? `${title.slice(0, 60)}…` : title;
}

/** 一行会话读数：身份、状态、原因、积压与可核对引用。 */
function describeRow(row: SessionContinuity): string {
	const reason = [...row.because, ...row.unknowns][0] ?? "";
	const title = titleOf(row);
	const notices =
		row.delivery.pendingNotices > 0
			? ` pending=${row.delivery.pendingPaths.length}`
			: "";
	const refs = row.refs.length > 0 ? ` refs=[${row.refs.join(",")}]` : "";
	return `- ${row.threadId} ${flagOf(row)} ${STATE_LABEL[row.state]}${title ? ` ${title}` : ""}${reason ? ` · ${reason}` : ""}${notices}${refs}`;
}

export const continuityTool: McpTool = {
	name: "continuity",
	description:
		"读取会话延续性：某条会话有没有一条没被回答的回合中断（三态 intact/review/unknown），投递积压单列不计入状态。只读，不重跑、不重投、不改线程。",
	inputSchema: {
		type: "object",
		properties: {
			threadId: {
				type: "string",
				description: "指定线程 id 返回详细读数；不传则列出所有会话并计数。",
			},
			limit: {
				type: "integer",
				description: "不传 threadId 时最多列出的会话数，默认 20，最大 100。",
			},
		},
	},
	async run(params, bb) {
		const threadId =
			typeof params.threadId === "string" && params.threadId.trim()
				? params.threadId.trim()
				: undefined;
		if (threadId) {
			try {
				const row = await readSessionContinuity(bb, threadId);
				const lines = [
					`线程 ${row.threadId} · ${STATE_LABEL[row.state]}`,
					`身份：${row.identity.lane ?? "未绑定车道"}；provider 会话 ${row.identity.providerSessionId ?? "无"}；${row.identity.resumable ? "可续" : "不可续"}`,
					`回合：完成 ${row.turns.completed} 轮，最近一条 ${row.turns.lastAt ?? "无"}${row.turns.open ? "（末条是人类消息，未获回复）" : ""}`,
					`联合判读：${PRIORITY_LABEL[row.priority]}`,
					`投递：待投递 ${row.delivery.pendingNotices} 条，已投递 ${row.delivery.deliveredNotices} 次`,
					...row.turns.interruptions.map(
						(interruption) =>
							`中断：${interruption.at}（${interruption.reason}，${interruption.messageCount === null ? "条数未记录" : `${interruption.messageCount} 条消息`}）· ${interruption.recovered ? "之后已回复" : "之后没有回复"}`,
					),
					...row.because.map((reason) => `! ${reason}`),
					...row.turns.cancellations.map(
						(cancellation) =>
							`用户终止：${cancellation.at}（${cancellation.messageCount === null ? "条数未记录" : `当时 ${cancellation.messageCount} 条消息`}）`,
					),
					...row.unknowns.map((unknown) => `? ${unknownLine(unknown)}`),
					...(row.refs.length > 0 ? [`可核对：${row.refs.join("、")}`] : []),
				];
				return truncate(lines.join("\n"));
			} catch (error) {
				// 不存在的线程是调用者的输入问题，可读地报出来，不让 JSON-RPC 变成崩溃。
				return truncate(`无法读取会话 ${threadId}：${String(error)}`);
			}
		}
		const { rows, summary } = await readAllSessionContinuity(bb);
		if (rows.length === 0) {
			return "（还没有对话线程）";
		}
		const top = rows.slice(0, limitOf(params.limit, 20));
		const header = `共 ${summary.total} 条会话：无待办观察 ${summary.intact} · 需要人看一眼 ${summary.review} · 材料不足 ${summary.unknown} · 有未投递通知 ${summary.pending}（展示 ${top.length}）；先看断点 ${summary.breakFirst} · 只有积压 ${summary.backlogOnly} · 无待办 ${summary.neither}`;
		return truncate(`${header}\n${top.map(describeRow).join("\n")}`);
	},
};
