/**
 * 「只认可落笔（requireEdits）」候选过滤的**先量后定**测量（TF-0161 后续）。
 *
 * 背景：2026-09-11 两轮真人复核（VAS1EM 10 条 + 1OioVM 12 条，共 22 条真实候选）
 * 收敛出一条判据——用户认可的地标 = **承载了实际改动**的文件。被驳回的 10 条
 * 全部是「只有 selection、没有 edit」的纯浏览项。
 *
 * 这个脚本做三件事，**都不改默认行为**：
 *   1. 把两轮的真人结论当标签，量「有 edit 即认可」这条规则的真实命中率；
 *   2. 量 requireEdits 开/关两种口径下，候选集合怎么变（少了几条、是否误杀认可项）；
 *   3. 拒绝把脚本读数当认可：本脚本只量投影，不写任何 review 事件。
 *
 * 跑法：
 *   bun scripts/e2e/landmark-require-edits-sweep.ts
 *   bun scripts/e2e/landmark-require-edits-sweep.ts --json
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { openBlackboard } from "../../src/blackboard";
import {
	landmarkCandidates,
	RECORDING_WRITER_KINDS as RECORDING_KINDS,
} from "../../src/interactions/landmark-set";
import {
	INTERACTIONS_SOURCE,
	INTERACTIONS_TYPE,
} from "../../src/interactions/types";
import type { WorkbenchEvent } from "../../src/types/event";

/** 落盘现场（持久目录，不会被系统清理）。 */
const SITES: Array<{ label: string; root: string }> = [
	{
		label: "VAS1EM",
		root: join(
			import.meta.dir,
			"../../.evidence-sites/live-run-2026-09-11-VAS1EM",
		),
	},
	{
		label: "1OioVM",
		root: join(
			import.meta.dir,
			"../../.evidence-sites/live-run-2026-09-11-1OioVM",
		),
	},
];

interface Shape {
	label: string;
	writer: string;
	handle: string;
	verdict: "endorse" | "reject";
	edits: number;
	selections: number;
	reason: string;
}

interface SiteReadout {
	label: string;
	exists: boolean;
	samples: Shape[];
	/** 关（现行默认）与开（候选过滤）两种口径下的候选集合。 */
	off: string[];
	on: string[];
}

/** 从黑板事件里抽「(writer, handle) → 真人结论」。只取 human 来源。 */
function humanVerdicts(events: WorkbenchEvent[]) {
	const verdicts = new Map<string, { verdict: string; reason: string }>();
	for (const event of events) {
		if (event.type !== "landmark.reviewed") continue;
		if (event.source !== "human") continue;
		const payload = event.payload as {
			writer?: string;
			handle?: string;
			verdict?: string;
			reason?: string;
		} | null;
		if (!payload?.writer || !payload.handle) continue;
		verdicts.set(`${payload.writer}\u0000${payload.handle}`, {
			verdict: payload.verdict ?? "",
			reason: payload.reason ?? "",
		});
	}
	return verdicts;
}

/** 每个 (writer, handle) 的 edit / selection 次数，用来量形状。 */
function shapeCounts(events: WorkbenchEvent[]) {
	const counts = new Map<string, { edits: number; selections: number }>();
	for (const event of events) {
		if (
			event.source !== INTERACTIONS_SOURCE ||
			event.type !== INTERACTIONS_TYPE
		)
			continue;
		const item = event.payload as {
			origin?: string;
			handle?: string;
			kind?: string;
			contentType?: string;
		} | null;
		if (!item?.origin || !item.handle) continue;
		if (item.contentType !== "file") continue;
		const key = `${item.origin}\u0000${item.handle}`;
		const row = counts.get(key) ?? { edits: 0, selections: 0 };
		if (item.kind === "edit") row.edits += 1;
		else if (item.kind === "selection") row.selections += 1;
		counts.set(key, row);
	}
	return counts;
}

async function readSite(label: string, root: string): Promise<SiteReadout> {
	const bbRoot = join(root, ".workbench");
	if (!existsSync(bbRoot)) {
		return { label, exists: false, samples: [], off: [], on: [] };
	}
	const bb = openBlackboard(bbRoot);
	const events = await bb.events.query({});
	const verdicts = humanVerdicts(events);
	const counts = shapeCounts(events);
	const writers = await bb.sessions.list();

	const samples: Shape[] = [];
	for (const [key, row] of counts) {
		const found = verdicts.get(key);
		if (!found) continue;
		if (found.verdict !== "endorse" && found.verdict !== "reject") continue;
		const [writer = "", handle = ""] = key.split("\u0000");
		samples.push({
			label,
			writer,
			handle,
			verdict: found.verdict,
			edits: row.edits,
			selections: row.selections,
			reason: found.reason,
		});
	}

	const collect = (requireEdits: boolean) => {
		const out: string[] = [];
		for (const writer of writers) {
			if (RECORDING_KINDS.has(writer.kind)) continue;
			const top = landmarkCandidates(events, writer.id, {
				denominator: "session-top-k",
				requireEdits,
			});
			for (const handle of top) out.push(`${writer.id}\u0000${handle}`);
		}
		return out;
	};
	return {
		label,
		exists: true,
		samples,
		off: collect(false),
		on: collect(true),
	};
}

function pct(numerator: number, denominator: number): string {
	if (denominator === 0) return "无样本";
	return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

const asJson = Bun.argv.includes("--json");
const readouts: SiteReadout[] = [];
for (const site of SITES) {
	readouts.push(await readSite(site.label, site.root));
}

const live = readouts.filter((r) => r.exists);
const allSamples = live.flatMap((r) => r.samples);

// 规则命中率：有 edit 即认可，无 edit 即驳回
let hit = 0;
const misses: Shape[] = [];
for (const sample of allSamples) {
	const predicted = sample.edits >= 1 ? "endorse" : "reject";
	if (predicted === sample.verdict) hit += 1;
	else misses.push(sample);
}

// 过滤的影响：关→开，少掉的候选里有多少是「真人认可」的（误杀）
const killed: Array<{ site: string; key: string; wasEndorsed: boolean }> = [];
for (const site of live) {
	const onSet = new Set(site.on);
	for (const key of site.off) {
		if (onSet.has(key)) continue;
		const sample = site.samples.find(
			(s) => `${s.writer}\u0000${s.handle}` === key,
		);
		killed.push({
			site: site.label,
			key: key.replace("\u0000", " / "),
			wasEndorsed: sample?.verdict === "endorse",
		});
	}
}

if (asJson) {
	console.log(
		JSON.stringify(
			{
				samples: allSamples.length,
				ruleHit: hit,
				ruleTotal: allSamples.length,
				misses,
				perSite: live.map((r) => ({
					label: r.label,
					off: r.off.length,
					on: r.on.length,
				})),
				killed,
			},
			null,
			2,
		),
	);
} else {
	console.log("# 「只认可落笔（requireEdits）」先量后定（TF-0161 后续）\n");
	console.log(
		`- 现场：${live.map((r) => r.label).join(" · ") || "（无可用现场）"}`,
	);
	console.log(`- 真人标注样本：${allSamples.length} 条`, "");
	for (const site of readouts) {
		if (!site.exists) {
			console.log(
				`  - ${site.label}：**缺现场**（落盘目录不存在），不冒充完整。`,
			);
		}
	}
	console.log("");
	console.log("## 表一·规则「有 edit 即认可、无 edit 即驳回」的真实命中率\n");
	console.log(
		`- 命中 **${hit} / ${allSamples.length} = ${pct(hit, allSamples.length)}**`,
	);
	if (misses.length > 0) {
		console.log("- 错判：");
		for (const m of misses) {
			console.log(
				`  - ${m.label} · \`${m.writer.slice(0, 8)}\` \`${m.handle}\`：真值 ${m.verdict}，edit ${m.edits} / selection ${m.selections}${m.reason ? ` · ${m.reason}` : ""}`,
			);
		}
	}
	console.log("");
	console.log("## 表二·过滤开/关对候选集合的影响\n");
	console.log(
		"| 现场 | 关（现行默认） | 开（只认可落笔） | 少掉 | 其中被认可 |",
	);
	console.log("| --- | --- | --- | --- | --- |");
	for (const site of live) {
		const removed = site.off.length - site.on.length;
		const killedEndorsed = killed.filter(
			(k) => k.site === site.label && k.wasEndorsed,
		).length;
		console.log(
			`| ${site.label} | ${site.off.length} | ${site.on.length} | ${removed} | ${killedEndorsed} |`,
		);
	}
	console.log("");
	if (killed.length > 0) {
		console.log("被过滤掉的候选（逐条）：");
		for (const k of killed) {
			const tag = k.wasEndorsed ? "**被认可过（误杀！）**" : "被驳回（清对了）";
			console.log(`  - ${k.site} · ${k.key} → ${tag}`);
		}
	} else {
		console.log("没有任何候选被过滤掉。");
	}
	console.log("");
	console.log("## 纪律声明\n");
	console.log(
		"- 本脚本**只量投影，不写 review 事件**：脚本读数不构成用户认可。",
	);
	console.log(
		"- 默认仍是 `requireEdits: false`。翻默认是**口径变更**，必须显式，且翻完要**重跑真人复核**——不得拿旧结论套新集合。",
	);
	console.log(
		"- 「先量后定」：本文数字只说明过滤在**已知样本**上的表现，不构成翻默认的依据。",
	);
}
