/**
 * 「只读型会话豁免」的形状测量（TF-0161 后续 · 翻默认前置第 2 步）。
 *
 * 问题：条目级 `requireEdits` 会零掉「本次会话的目的就是读」的会话
 * （VAS1EM `21273cbd` 形状：会话标题是复核，唯一的工作就是去读那个文件）。
 * 本脚本只回答一个问题：**会话级**的形状里，有没有一个信号能把
 * 「只读是它的工作」（该留）与「读了但没干活」（该清）分开？
 *
 * 口径与基线一致：只统计**文件级** handle（目录不进 L1 候选，
 * 人类对 `src` 的两条复核属于集合外结论，不进本测量）。
 *
 * 输出是候选规则在已知 22 条真人标注上的命中率，供选规则用；
 * 脚本只量投影、不写任何 review 事件，不构成翻默认的依据。
 */

import { join } from "node:path";
import { openBlackboard } from "../../src/blackboard";
import {
	isRecordingWriter,
	landmarkCandidates,
} from "../../src/interactions/landmark-set";
import {
	INTERACTIONS_SOURCE,
	INTERACTIONS_TYPE,
} from "../../src/interactions/types";
import type { WorkbenchEvent } from "../../src/types/event";

const SITES = ["live-run-2026-09-11-VAS1EM", "live-run-2026-09-11-1OioVM"];

interface Row {
	site: string;
	writer: string;
	handle: string;
	verdict: "endorse" | "reject";
	/** 该 handle 自身的形状。 */
	itemEdits: number;
	/** 该会话（writer）整体的形状。 */
	sessionEdits: number;
}

function humanVerdicts(events: WorkbenchEvent[]) {
	const map = new Map<string, { verdict: string; reason: string }>();
	for (const event of events) {
		if (event.type !== "landmark.reviewed" || event.source !== "human")
			continue;
		const p = event.payload as {
			writer?: string;
			handle?: string;
			verdict?: string;
			reason?: string;
		} | null;
		if (!p?.writer || !p.handle) continue;
		map.set(`${p.writer}\u0000${p.handle}`, {
			verdict: p.verdict ?? "",
			reason: p.reason ?? "",
		});
	}
	return map;
}

function interactionsOf(events: WorkbenchEvent[], writer: string) {
	return events.filter(
		(e) =>
			e.source === INTERACTIONS_SOURCE &&
			e.type === INTERACTIONS_TYPE &&
			(e.payload as { origin?: string } | null)?.origin === writer,
	);
}

const rows: Row[] = [];
const siteCandidates: Array<{
	site: string;
	off: number;
	itemOnly: number;
	withExemption: number;
	killedEndorsedItem: number;
	killedEndorsedExempt: number;
}> = [];

for (const site of SITES) {
	const root = join(
		import.meta.dir,
		"../../.evidence-sites",
		site,
		".workbench",
	);
	const bb = openBlackboard(root);
	const events = await bb.events.query({});
	const verdicts = humanVerdicts(events);
	const fileHandles = new Set(
		events
			.filter(
				(e) =>
					e.source === INTERACTIONS_SOURCE &&
					e.type === INTERACTIONS_TYPE &&
					(e.payload as { contentType?: string } | null)?.contentType ===
						"file",
			)
			.map((e) => (e.payload as { handle?: string } | null)?.handle),
	);
	for (const [key, v] of verdicts) {
		if (v.verdict !== "endorse" && v.verdict !== "reject") continue;
		const [writer = "", handle = ""] = key.split("\u0000");
		// 目录级复核（如 `src`）不进 L1 候选，排除出测量，与 22 条基线对齐。
		if (!fileHandles.has(handle)) continue;
		const mine = interactionsOf(events, writer);
		rows.push({
			site,
			writer,
			handle,
			verdict: v.verdict,
			itemEdits: mine.filter(
				(e) =>
					(e.payload as { kind?: string } | null)?.kind === "edit" &&
					(e.payload as { handle?: string } | null)?.handle === handle,
			).length,
			sessionEdits: mine.filter(
				(e) => (e.payload as { kind?: string } | null)?.kind === "edit",
			).length,
		});
	}

	// 三种口径下的候选集合：关 / 条目级过滤 / 条目级过滤 + 只读会话豁免
	const writers = (await bb.sessions.list()).filter(
		(w) => !isRecordingWriter(w),
	);
	const editedWriters = new Set(
		events
			.filter(
				(e) =>
					e.source === INTERACTIONS_SOURCE &&
					e.type === INTERACTIONS_TYPE &&
					(e.payload as { kind?: string } | null)?.kind === "edit",
			)
			.map((e) => (e.payload as { origin?: string } | null)?.origin),
	);
	// 三份候选集合直算（off / itemOnly / withExemption），不绕闭包。
	const off: string[] = [];
	const itemOnly: string[] = [];
	const withExemption: string[] = [];
	for (const w of writers) {
		// 基线必须显式 requireEdits: false：2026-09-11 翻默认后，缺省调用已是
		// 过滤后的集合，会破坏「关」基线的含义。
		const top = landmarkCandidates(events, w.id, {
			denominator: "session-top-k",
			requireEdits: false,
		});
		for (const handle of top) off.push(`${w.id}\u0000${handle}`);
		const hasEdits = editedWriters.has(w.id);
		const edited = new Set(
			events
				.filter(
					(e) =>
						e.source === INTERACTIONS_SOURCE &&
						e.type === INTERACTIONS_TYPE &&
						(e.payload as { kind?: string } | null)?.kind === "edit" &&
						(e.payload as { origin?: string } | null)?.origin === w.id,
				)
				.map((e) => (e.payload as { handle?: string } | null)?.handle),
		);
		// 条目级过滤：有落笔会话只留落笔项，零落笔会话整会话清零
		if (hasEdits) {
			for (const handle of top)
				if (edited.has(handle)) itemOnly.push(`${w.id}\u0000${handle}`);
		}
		// 豁免版：零落笔会话原样保留，有落笔会话同条目级
		if (hasEdits) {
			for (const handle of top)
				if (edited.has(handle)) withExemption.push(`${w.id}\u0000${handle}`);
		} else {
			for (const handle of top) withExemption.push(`${w.id}\u0000${handle}`);
		}
	}

	const endorseSet = new Set(
		rows
			.filter((r) => r.site === site && r.verdict === "endorse")
			.map((r) => `${r.writer}\u0000${r.handle}`),
	);
	const killedBy = (kept: string[]) =>
		off.filter((key) => !kept.includes(key) && endorseSet.has(key)).length;
	siteCandidates.push({
		site,
		off: off.length,
		itemOnly: itemOnly.length,
		withExemption: withExemption.length,
		killedEndorsedItem: killedBy(itemOnly),
		killedEndorsedExempt: killedBy(withExemption),
	});
}

console.log(`# 只读型会话豁免 · 形状测量（文件级样本 ${rows.length} 条）\n`);
console.log("## 候选规则对比（在真人标注上的命中率）\n");
const rules: Array<{
	name: string;
	predict: (r: Row) => "endorse" | "reject";
}> = [
	{
		name: "S0·只看会话级（会话有 edit 就全认可）——对照组，证明会话级单独不成立",
		predict: (r) => (r.sessionEdits >= 1 ? "endorse" : "reject"),
	},
	{
		name: "S1·条目级（现状 requireEdits：该文件有 edit 才认可）",
		predict: (r) => (r.itemEdits >= 1 ? "endorse" : "reject"),
	},
	{
		name: "S2·条目级 + 只读会话豁免（该文件有 edit，**或**整个会话零落笔）",
		predict: (r) =>
			r.itemEdits >= 1 || r.sessionEdits === 0 ? "endorse" : "reject",
	},
];
for (const rule of rules) {
	const hit = rows.filter((r) => rule.predict(r) === r.verdict).length;
	const mis = rows.filter((r) => rule.predict(r) !== r.verdict);
	console.log(
		`- **${rule.name}**：${hit} / ${rows.length} = ${((hit / rows.length) * 100).toFixed(1)}%` +
			(mis.length
				? `　错判 ${mis.length} 条 → ${mis
						.map(
							(m) =>
								`${m.writer.slice(0, 8)}/${m.handle}（真值${m.verdict === "endorse" ? "认可" : "驳回"}）`,
						)
						.join("、")}`
				: "　无错判"),
	);
}
console.log(
	"\n  注：S2 的豁免只看「会话有没有 edit」这一个信号，不看频率、不看内容，\n  与种类门同一个设计原则（门只看最窄的信号）。",
);
console.log("\n## 三种口径下的候选集合（先量后定，假想值，不是实测读数）\n");
console.log(
	"| 现场 | 关（现行默认） | 条目级过滤 | 条目级 + 豁免 | 条目级误杀认可项 | 豁免版误杀认可项 |",
);
console.log("| --- | --- | --- | --- | --- | --- |");
for (const s of siteCandidates) {
	console.log(
		`| ${s.site.slice(-6)} | ${s.off} | ${s.itemOnly} | ${s.withExemption} | ${s.killedEndorsedItem} | ${s.killedEndorsedExempt} |`,
	);
}
console.log("\n## 纪律声明\n");
console.log("- 本脚本**只量投影，不写 review 事件**：脚本读数不构成用户认可。");
console.log(
	"- 默认仍是 `requireEdits: false`。翻默认是**口径变更**，必须显式，且翻完要**重跑真人复核**。",
);
console.log(
	"- 豁免类的样本只有 1 条（`21273cbd`）：n=1，结论是「数据不反对此豁免」而非「豁免已充分验证」。",
);
