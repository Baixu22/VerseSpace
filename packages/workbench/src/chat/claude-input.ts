import type { ParsedStreamFootprint } from "../blackboard/footprint";
import {
	normalizeInput,
	type ReturnedInput,
	sameInputPath,
	singleCatPath,
} from "../blackboard/input-content";
import { asRecord, contentBlocks } from "./claude-render-blocks";

/** Retained stream-json Read shape: structured file plus exactly numbered return text. */
export function claudeReturnedInput(
	root: string,
	footprint: ParsedStreamFootprint,
	block: Record<string, unknown>,
	event: Record<string, unknown>,
): ReturnedInput {
	if (
		footprint.activity === "act-unknown" ||
		block.tool_use_id !== footprint.activity
	)
		return { reason: "缺少可关联的工具调用身份" };
	const used = footprint.used[0];
	const wire = block.content;
	if (footprint.used.length !== 1 || !used)
		return { reason: "返回内容无法唯一对应一个文件" };
	if (typeof wire !== "string") return { reason: "缺少可识别的文本返回" };
	const result = asRecord(event.tool_use_result);
	if (result?.truncated === true || result?.interrupted === true)
		return { reason: "工具返回已截断或中断" };
	if (footprint.facets.tool === "Bash") {
		const path = singleCatPath(String(footprint.facets.command ?? ""));
		return path && sameInputPath(root, path, used.path)
			? { returned: wire, content: wire, selector: { kind: "file" } }
			: { reason: "仅单文件 cat 可归因，命令或范围未建模" };
	}
	if (footprint.facets.tool !== "Read")
		return { reason: "目录、搜索或命令结果未绑定文件内容" };
	const results = contentBlocks(event).filter(
		(value) => asRecord(value)?.type === "tool_result",
	);
	const file = asRecord(result?.file);
	if (
		results.length !== 1 ||
		result?.type !== "text" ||
		!file ||
		typeof file.filePath !== "string" ||
		!sameInputPath(root, file.filePath, used.path) ||
		typeof file.content !== "string" ||
		file.truncated === true
	)
		return { reason: "Read 结构化内容缺失、路径错配或多结果歧义" };
	const { startLine, numLines, totalLines } = file;
	if (
		![startLine, numLines, totalLines].every(
			(n) => Number.isSafeInteger(n) && Number(n) > 0,
		)
	)
		return { reason: "Read 返回行范围未知" };
	const start = startLine as number;
	const count = numLines as number;
	const total = totalLines as number;
	const end = start + count - 1;
	const lines = normalizeInput(file.content).split("\n");
	if (
		lines.length !== count ||
		end > total ||
		normalizeInput(wire) !==
			lines.map((line, i) => `${start + i}\t${line}`).join("\n")
	)
		return { reason: "Read 原文与结构化内容/行数不一致" };
	if (used.span) {
		if (start !== used.span.start || end !== Math.min(used.span.end, total))
			return { reason: "Read 返回未覆盖声明的行范围" };
		return {
			returned: wire,
			content: file.content,
			selector: { kind: "lines", start, end },
		};
	}
	return start === 1 && count === total
		? { returned: wire, content: file.content, selector: { kind: "file" } }
		: { reason: "全文件 Read 返回被截断或范围不完整" };
}
