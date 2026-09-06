import type { ReadSetDiff } from "../../runtime/read-set-diff";
import type { CoverageRow } from "./types";

/**
 * Wordings the card must never produce (TF-0129 验收一、五).
 *
 * A restore card is a fact check over a partial read set. "No changes" and
 * "safe" are conclusions it is not entitled to draw: the read set may have
 * covered nothing at all, and a writer who is told "safe" once and burned once
 * will not read the card again.
 */
export const FORBIDDEN_CARD_PHRASES = [
	"无变化",
	"没有变化",
	"没有改动",
	"安全",
	"一切正常",
] as const;

export function coverageOf(
	diff: ReadSetDiff | null,
	changed: number,
): CoverageRow {
	const base = {
		compared: diff?.compared ?? 0,
		comparable: diff?.comparable ?? 0,
		changed,
		excludedDurable: diff?.excludedDurable ?? 0,
		excludedDirectories: diff?.excludedDirectories ?? 0,
		unsupported: diff?.unsupported ?? 0,
		uncoveredTools: diff?.uncoveredTools ?? [],
	};
	const tools =
		base.uncoveredTools.length > 0
			? `；未覆盖的工具：${base.uncoveredTools.join("、")}`
			: "";
	const excluded: string[] = [];
	if (base.excludedDirectories > 0) {
		excluded.push(`${base.excludedDirectories} 个目录检索`);
	}
	if (base.excludedDurable > 0) {
		excluded.push(`${base.excludedDurable} 个可复现文件`);
	}
	const excludedText =
		excluded.length > 0 ? `（已剔除 ${excluded.join(" / ")}）` : "";

	if (diff === null || diff.status === "unknown") {
		return {
			...base,
			status: "unknown",
			text: "覆盖范围未知：没有离开时的读集基线，无法判断这次离开期间哪些前提变过。",
		};
	}
	if (base.comparable === 0) {
		return {
			...base,
			status: "unknown",
			text:
				`覆盖范围未知：${base.compared} 个读取里 0 个可比对${excludedText}${tools}。` +
				"这张卡片没有依据判断你的前提是否还成立。",
		};
	}
	return {
		...base,
		status: "available",
		text: `覆盖率：${base.compared} 个读取里 ${base.comparable} 个可比对，其中 ${base.changed} 个已变${excludedText}${tools}。`,
	};
}
