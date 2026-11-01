import { pendingPremiseNotices } from "../../runtime/delivery";
import { limitOf, type McpTool, truncate } from "./types";

/** `notices`：投递这一维——已投递的记录与仍待投递的数量。 */
export const noticesTool: McpTool = {
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
};
