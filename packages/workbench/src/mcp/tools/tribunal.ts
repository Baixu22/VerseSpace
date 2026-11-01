import { limitOf, type McpTool, truncate } from "./types";

/** `tribunal`：系统答不了、需要人类决策的队列。只读，不裁决。 */
export const tribunalTool: McpTool = {
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
};
