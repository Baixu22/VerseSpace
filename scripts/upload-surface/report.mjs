/**
 * Report rendering — the presentation half of the upload-surface gate.
 *
 * Kept out of `check-upload-surface.mjs` for the same reason `classify.mjs` is:
 * one responsibility per file. The gate measures and decides; this file only
 * says how a verdict is shown. The wording IS part of the contract (Chinese
 * labels, the `--json` shape, the `SHOW` truncation, the per-signal sections),
 * so moving it here must not change a single reading.
 */

/**
 * Violation codes in report order. The optional fourth element formats one hit;
 * codes without one print just the path.
 */
const GROUPS = [
	["useful-not-uploaded", "有用未传", "应上传却被 .gitignore 排除"],
	["useless-uploaded", "无用已传", "应留本机却进入上传面"],
	["unclassified", "未定性", "策略未覆盖，需显式归类"],
	["oversize-uploaded", "超限已传", "单文件超过体量上限"],
	["referenced-but-local", "被引用却未传", "已入库文档指向本机文档"],
	[
		"broken-relative-link",
		"断链",
		"已上传文档的相对链接指向不存在的路径",
		(hit) => `${hit.path} → ${hit.target}（原文 ${hit.raw}）`,
	],
];

/**
 * Print the report. `--json` writes the machine-readable shape and nothing
 * else; the human summary follows the same order every run so a reading can be
 * diffed: status → counts → relative-link reading → notes → problems →
 * violations → pending references → adjudicated references.
 *
 * `notes` and `problems` belong to the measurement step, so the gate passes
 * them in; `show` is the truncation limit for every list.
 */
export function emitReport({
	report,
	asJson = false,
	measured = true,
	notes = [],
	problems = [],
	show = 10,
}) {
	if (asJson) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return;
	}

	const status = !measured
		? "无法测量"
		: report.status === "clean"
			? "上传面已定性，双向无违规"
			: "有违规";
	console.log(`[upload-surface] ${status}`);
	if (report.counts) {
		console.log(
			`  上传面 ${report.counts.uploaded} 个文件 · 本机遗留 ${report.counts.ignored} 个 · 违规 ${report.counts.violations} 条`,
		);
	}
	if (report.relativeLinks) {
		console.log(
			`  相对链接 ${report.relativeLinks.checked} 条 · 断链 ${report.relativeLinks.broken.length} 条` +
				"（只查上传面 .md，按引用文件所在目录解析；本机遗留文档不在范围内）",
		);
	}
	for (const note of notes) {
		console.log(`  备注：${note}`);
	}
	for (const problem of problems) {
		console.log(`  ${problem}`);
	}
	for (const [code, label, hint, format] of GROUPS) {
		const hits = report.violations.filter((item) => item.code === code);
		if (hits.length === 0) {
			continue;
		}
		console.log(`  ${label}（${code}）${hits.length} 条 — ${hint}`);
		for (const hit of hits.slice(0, show)) {
			console.log(`    · ${format ? format(hit) : hit.path}`);
		}
		if (hits.length > show) {
			console.log(`    … 其余 ${hits.length - show} 条见 --json`);
		}
	}
	const referenceNotes = report.referenceNotes ?? [];
	if (referenceNotes.length > 0) {
		console.log(
			`  待裁决（referenced-but-local）${referenceNotes.length} 条 — 已入库文档指向本机文档；` +
				"需人工决定「提升目标」还是「改掉引用」，加 --strict-references 可将其视为违规",
		);
		for (const note of referenceNotes.slice(0, show)) {
			console.log(`    · ${note.path} ← ${note.detail}`);
		}
		if (referenceNotes.length > show) {
			console.log(`    … 其余 ${referenceNotes.length - show} 条见 --json`);
		}
	}
	const acceptedReferences = report.acceptedReferences ?? [];
	if (acceptedReferences.length > 0) {
		console.log(
			`  已裁决（referenced-but-local）${acceptedReferences.length} 条 — 引用已在 policy.acceptedLocalReferences 里逐条记录，不再阻塞门禁`,
		);
		for (const entry of acceptedReferences.slice(0, show)) {
			console.log(`    · ${entry.path} ← ${entry.detail}`);
		}
		if (acceptedReferences.length > show) {
			console.log(`    … 其余 ${acceptedReferences.length - show} 条见 --json`);
		}
	}
}
