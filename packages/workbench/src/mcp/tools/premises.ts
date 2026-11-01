import { pendingPremiseNotices } from "../../runtime/delivery";
import { currentPremiseNotices } from "../../runtime/premises";
import { limitOf, type McpTool, truncate } from "./types";

/**
 * `premises`：前提失效的两面——待投递的通知，与当前重新核对的失效输入。
 * `view=current` 不以「送达」当作解决，两者互不替代。
 */
export const premisesTool: McpTool = {
	name: "premises",
	description:
		"查询前提：view=pending（默认）读取待投递通知；view=current 重新核对当前读集，不以送达当作解决。仅限可观测读取，只读。",
	inputSchema: {
		type: "object",
		properties: {
			view: {
				type: "string",
				enum: ["pending", "current"],
				description: "通知投递状态或当前读取前提。",
			},
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
		if (params.view === "current") {
			const current = await currentPremiseNotices(
				bb,
				typeof params.writer === "string" ? params.writer : undefined,
			);
			const top = current.slice(0, limitOf(params.limit, 10));
			return truncate(
				`当前失效前提 ${current.length} 个写者（仅限可观测读取；与投递状态无关）：\n${top.map((n) => `- writer=${n.writerId}\n  ${n.stale.map((c) => `${c.path} ${c.observedVersion ?? "未知"} → ${c.currentVersion ?? "未知"}`).join("；")}`).join("\n")}`,
			);
		}
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
};
