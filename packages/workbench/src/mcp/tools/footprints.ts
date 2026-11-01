import { inputCoverageView } from "../../blackboard/input-coverage";
import type { WorkbenchEvent } from "../../types/event";
import { limitOf, type McpTool, truncate } from "./types";

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

/** `footprints`：agent 实际读/写了哪些文件；给了 writer 时附带读集覆盖读数。 */
export const footprintsTool: McpTool = {
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
		const coverage = writer ? await inputCoverageView(bb, writer) : undefined;
		const views = [...events]
			.reverse()
			.map(toFootprintView)
			.filter((v) => writer === undefined || v.writer === writer);
		if (views.length === 0) {
			return coverage
				? truncate(`没有足迹事件。\n${coverage.text}`)
				: "没有足迹事件。";
		}
		const lines = views.map(
			(v) =>
				`- ${v.at} writer=${v.writer} tool=${v.tool} used=[${v.used.join(",")}] generated=[${v.generated.join(",")}]`,
		);
		return truncate(
			`${coverage ? `${coverage.text}\n` : ""}最近足迹 ${views.length} 条：\n${lines.join("\n")}`,
		);
	},
};
