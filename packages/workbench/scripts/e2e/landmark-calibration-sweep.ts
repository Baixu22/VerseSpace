/**
 * 地标标定扫描（TF-0156 验收一的数据源）：同一条真实事件流，换常数看地标集合
 * 变成什么。只读：不写黑板、不改常数，只把「改常数会发生什么」变成可比较的数字。
 *
 * 为什么需要它：L1 的判据是「地标集合里 ≥80% 是用户认可的核心」。如果地标集合
 * 里一半是 src / `.` 这类容器，这条判据就不是在量产品准不准，而是在量容器占位
 * 多少——2026-09-11 的第一次扫描（租户 95 个写者、17 轮真实模型采样）结果：
 *
 *   floor=10 edit=2（出厂）  地标   5 条（容器 2，40%）· 触发写者  2 / 无地标 70
 *   floor=6  edit=2         地标  10 条（容器 7，70%）· 触发写者  7 / 无地标 65
 *   floor=4  edit=2         地标  42 条（容器 21，50%）· 触发写者 20 / 无地标 52
 *   floor=10 edit=4         地标   5 条（容器 2，40%）· 触发写者  2 / 无地标 70
 *   floor=6  edit=4         地标  46 条（容器 25，54%）· 触发写者 20 / 无地标 52
 *
 * 两个结论都不是「阈值调一下就好」：容器的占比在任何阈值下都在 40–70%，因为它
 * 由 DOI 的父级传播份额决定（子条目拿到的兴趣按 share 传给父目录），阈值只决定
 * 覆盖多少个写者。所以「让核心进地标集合」要动的是粒度（文件级）与覆盖，不是阈值。
 *
 * 用法：
 *   bun scripts/e2e/landmark-calibration-sweep.ts --workspace <租户>
 *   bun scripts/e2e/landmark-calibration-sweep.ts --workspace <租户> --json
 */

import { openBlackboard } from "../../src/blackboard";
import {
	computeDoi,
	DEFAULT_DOI_CONFIG,
	type DoiConfig,
} from "../../src/interactions/doi";
import {
	INTERACTIONS_SOURCE,
	INTERACTIONS_TYPE,
	type InteractionEvent,
} from "../../src/interactions/types";
import type { WorkbenchEvent } from "../../src/types/event";

const argv = Bun.argv.slice(2);
const at = (flag: string): string | undefined => {
	const index = argv.indexOf(flag);
	return index >= 0 ? (argv[index + 1] as string | undefined) : undefined;
};
const workspace = at("--workspace") ?? at("--blackboard");
if (!workspace) {
	console.error("需要 --workspace <租户>（或 --blackboard <.workbench>）");
	process.exit(2);
}
const blackboardAt = workspace.endsWith(".workbench")
	? workspace
	: `${workspace}/.workbench`;

const SWEEP: Array<{ label: string; config: DoiConfig }> = [
	{ label: "floor=10 edit=2（出厂）", config: DEFAULT_DOI_CONFIG },
	{
		label: "floor=6  edit=2",
		config: { ...DEFAULT_DOI_CONFIG, landmarkFloor: 6 },
	},
	{
		label: "floor=4  edit=2",
		config: { ...DEFAULT_DOI_CONFIG, landmarkFloor: 4 },
	},
	{
		label: "floor=10 edit=4",
		config: {
			...DEFAULT_DOI_CONFIG,
			weight: { ...DEFAULT_DOI_CONFIG.weight, edit: 4 },
		},
	},
	{
		label: "floor=6  edit=4",
		config: {
			...DEFAULT_DOI_CONFIG,
			weight: { ...DEFAULT_DOI_CONFIG.weight, edit: 4 },
			landmarkFloor: 6,
		},
	},
];

const bb = openBlackboard(blackboardAt);
const writers = await bb.sessions.list();
const records: WorkbenchEvent[] = await bb.events.query({
	source: INTERACTIONS_SOURCE,
	type: INTERACTIONS_TYPE,
});
const scoped = (writer: string) =>
	records.filter((event) => {
		const item = event.payload as Partial<InteractionEvent> | null;
		return item?.origin === writer && typeof item.handle === "string";
	});

const rows: Array<{
	label: string;
	landmarks: number;
	containers: number;
	/** 文件级地标：L1 的分母用的就是它。 */
	files: number;
	writersHit: number;
	writersFileHit: number;
	writersStarved: number;
	handles: string[];
}> = [];
for (const { label, config } of SWEEP) {
	let writersHit = 0;
	let writersFileHit = 0;
	let writersStarved = 0;
	let landmarks = 0;
	let containers = 0;
	let files = 0;
	const handles = new Set<string>();
	for (const writer of writers) {
		const scopedRows = scoped(writer.id);
		if (scopedRows.length === 0) continue;
		const events = scopedRows.map((event) => event.payload as InteractionEvent);
		const result = computeDoi(events, Date.now(), config);
		if (result.landmarks.length === 0) {
			writersStarved += 1;
			continue;
		}
		writersHit += 1;
		landmarks += result.landmarks.length;
		let writerFiles = 0;
		for (const handle of result.landmarks) {
			// 容器判据用真实 contentType（DOI 结果里就有），不是「有没有扩展名」
			// 这种字符串启发式——`computeDoi` 对父级传播产生的条目会显式标 directory。
			const isContainer = result.scores.get(handle)?.contentType !== "file";
			containers += Number(isContainer);
			if (!isContainer) {
				files += 1;
				writerFiles += 1;
			}
			handles.add(handle);
		}
		if (writerFiles > 0) writersFileHit += 1;
	}
	rows.push({
		label,
		landmarks,
		containers,
		files,
		writersHit,
		writersFileHit,
		writersStarved,
		handles: [...handles].sort(),
	});
}

if (argv.includes("--json")) {
	console.log(
		JSON.stringify(
			{ blackboard: bb.paths.root, writers: writers.length, rows },
			null,
			1,
		),
	);
} else {
	console.log(`黑板 ${bb.paths.root} · 写者 ${writers.length} 个`);
	for (const row of rows)
		console.log(
			`${row.label.padEnd(22)} 地标 ${String(row.landmarks).padStart(4)} 条（容器 ${String(row.containers).padStart(3)}，占 ${((row.containers / Math.max(1, row.landmarks)) * 100).toFixed(0)}%，文件级 ${String(row.files).padStart(4)}）· 触发写者 ${row.writersHit}（文件级 ${row.writersFileHit} / 无地标写者 ${row.writersStarved}）· 去重 handle ${row.handles.length} [${row.handles.slice(0, 8).join(", ")}]`,
		);
}
