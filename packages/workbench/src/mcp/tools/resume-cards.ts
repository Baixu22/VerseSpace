import { artifactReviewProjection } from "../../artifacts/projection";
import { ChatThreads } from "../../chat/threads";
import { resumeCardText } from "../resume-card";
import { limitOf, type McpTool, truncate } from "./types";

/**
 * `resume_cards`：线程在离开期间发生了什么。
 * `view=card`（默认）读恢复卡文字；`view=artifacts` 读同一有限产物投影
 * ——两处共用 `chat/resume-card` 与 `artifacts/projection`，不各自算一份。
 */
export const resumeCardsTool: McpTool = {
	name: "resume_cards",
	description:
		"读取恢复卡：线程在离开期间发生了什么变化（读集 diff、分支动静、失效前提、恢复笔记）。只读。",
	inputSchema: {
		type: "object",
		properties: {
			view: {
				type: "string",
				enum: ["card", "artifacts"],
				description: "恢复卡文字或有体积上限的产物事实 JSON。",
			},
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
			if (params.view === "artifacts")
				return JSON.stringify(await artifactReviewProjection(bb, threadId));
			return truncate(await resumeCardText(bb, chat, threadId));
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
};
