import { formatNotice, type StalePremiseClaim } from "./premises";

export const DEFAULT_NOTICE_TOKEN_BUDGET = 300;

function omissionFooter(files: number, diffs: number): string {
	if (files === 0 && diffs === 0) return "";
	const parts = [];
	if (files) parts.push(`${files} 个文件未展开`);
	if (diffs) parts.push(`${diffs} 条 diff 因通知预算未完整展开`);
	return `\n\n（${parts.join("；")}；事件仍保留）`;
}

/** Facts stay whole; lower-priority diffs share the remaining approximate budget. */
export function renderNotice(
	claims: StalePremiseClaim[],
	tokenBudget = DEFAULT_NOTICE_TOKEN_BUDGET,
	foldedPaths: ReadonlySet<string> = new Set(),
): string {
	const budget = Number.isFinite(tokenBudget)
		? Math.max(0, Math.trunc(tokenBudget * 4))
		: DEFAULT_NOTICE_TOKEN_BUDGET * 4;
	if (!claims.length) return "";
	const minimal = `前提失效：${claims.length} 个文件。`;
	if (budget < minimal.length) return "";
	const compact = `前提失效：${claims.length} 个文件；详情未展开，事件仍保留。`;
	const header = formatNotice(claims.length);
	const familyClaims = claims.filter((claim) => foldedPaths.has(claim.path));
	const rows = claims
		.filter((claim) => !foldedPaths.has(claim.path))
		.map((claim) => ({
			text: `- ${claim.path}\n  观察版本 ${claim.observedVersion ?? "未知"} → 当前版本 ${claim.currentVersion ?? "未知"}`,
			claims: [claim],
			folded: false,
		}));
	if (familyClaims.length) {
		const preview = familyClaims
			.slice(0, 3)
			.map((claim) =>
				claim.path.length > 80 ? `${claim.path.slice(0, 79)}…` : claim.path,
			)
			.join("、");
		const more =
			familyClaims.length > 3 ? `；及另 ${familyClaims.length - 3} 条` : "";
		rows.push({
			text: `- 同一分叉家族近 30 分钟改动 ${familyClaims.length} 个文件（已折叠）：${preview}${more}`,
			claims: familyClaims,
			folded: true,
		});
	}
	const included: typeof rows = [];
	let output = header;
	for (const row of rows) {
		const separator = included.length ? "\n" : "\n\n";
		if (output.length + separator.length + row.text.length > budget) continue;
		included.push(row);
		output += separator + row.text;
	}
	let omittedFiles =
		claims.length - included.reduce((sum, row) => sum + row.claims.length, 0);
	const diffCount = (row: (typeof rows)[number]) =>
		row.folded ? 0 : row.claims.filter((claim) => claim.diff).length;
	let omittedDiffs = included.reduce((sum, row) => sum + diffCount(row), 0);
	// Make space for truthful omission counts by removing whole facts, never
	// by slicing through a path/version and still counting it as displayed.
	while (
		included.length &&
		output.length + omissionFooter(omittedFiles, omittedDiffs).length > budget
	) {
		const row = included.pop()!;
		omittedDiffs -= diffCount(row);
		omittedFiles += row.claims.length;
		output =
			header +
			(included.length
				? `\n\n${included.map((item) => item.text).join("\n")}`
				: "");
	}
	const reserve = omissionFooter(omittedFiles, omittedDiffs).length;
	if (output.length + reserve > budget)
		return compact.length <= budget ? compact : minimal;
	let remaining = budget - output.length - reserve;
	for (const claim of included
		.filter((row) => !row.folded)
		.flatMap((row) => row.claims)) {
		if (!claim.diff) continue;
		const marker = `\n\n${claim.path} 的 diff\n\`\`\`diff\n`;
		const suffix = "\n```";
		const fullLength = marker.length + claim.diff.length + suffix.length;
		if (fullLength <= remaining) {
			output += marker + claim.diff + suffix;
			remaining -= fullLength;
			omittedDiffs -= 1;
			continue;
		}
		const tail = "\n…（diff 已截断）";
		const room = remaining - marker.length - tail.length - suffix.length;
		if (room <= 0) continue;
		output += marker + claim.diff.slice(0, room) + tail + suffix;
		remaining = 0;
	}
	return output + omissionFooter(omittedFiles, omittedDiffs);
}
