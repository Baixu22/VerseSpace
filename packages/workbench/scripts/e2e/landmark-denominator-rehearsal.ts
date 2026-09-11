/**
 * TF-0159 分母切换预演（只读，不切产品代码）：把「切到相对选择会发生什么」
 * 变成可比较的数字，供决策者拍板。
 *
 * 文档定下的三个切换决定（docs/tf-0159-l1-denominator-migration.md §2）：
 *   2.1 双口径并报一个周期：endorsedShare（阈值口径）与 coverage/topK（相对口径）
 *       同时打印，各自标注口径，变化可归因到口径而不是产品。
 *   2.2 旧结论按 (writer, handle) 保留：落在新集合里的照旧计入；集合外的标 legacy，
 *       不删除、不改判。预演要量出「多少结论会变 legacy」。
 *   2.3 默认队列按会话抽样 N=5：读数里明写 sampledSessions，绝不把抽样写成全量。
 *
 * 预演叠加报告定下的种类门（TF-0161 候选 D）：git 监视 / human 编辑器不进候选。
 * 顺序纪律：先门后尺——门只清噪声不生产地标，门后空集 → TF-0159 从可选升为必须
 * （本仓库四现场实测：门+阈值 = 0 条，全空）。
 *
 * 用法：
 *   bun scripts/e2e/landmark-denominator-rehearsal.ts                    # 四现场
 *   bun scripts/e2e/landmark-denominator-rehearsal.ts --site live-tenant
 *   bun scripts/e2e/landmark-denominator-rehearsal.ts --json
 */

import { existsSync } from "node:fs";
import { openBlackboard } from "../../src/blackboard";
import { computeDoi, DEFAULT_DOI_CONFIG } from "../../src/interactions/doi";
import { RECORDING_WRITER_KINDS as RECORDING_KINDS } from "../../src/interactions/landmark-set";
import { collectLandmarkReviews } from "../../src/interactions/review";
import {
	INTERACTIONS_SOURCE,
	INTERACTIONS_TYPE,
	type InteractionEvent,
} from "../../src/interactions/types";

const argv = Bun.argv.slice(2);
const at = (flag: string): string | undefined => {
	const index = argv.indexOf(flag);
	return index >= 0 ? (argv[index + 1] as string | undefined) : undefined;
};

const SITES: Array<{ label: string; path: string }> = [
	{
		label: "live-tenant",
		path: "C:\\Users\\27933\\AppData\\Local\\Temp\\workbench-e2e-live-tenant\\.workbench",
	},
	{
		label: "node-verified",
		path: "C:\\Users\\27933\\AppData\\Local\\Temp\\workbench-node-verified-032fd3ea64a74c539a5d9d8cfeb3bf37\\.workbench",
	},
	{
		label: "LHA3I4",
		path: "C:\\Users\\27933\\AppData\\Local\\Temp\\workbench-e2e-LHA3I4\\.workbench",
	},
	{
		label: "VAKSgQ",
		path: "C:\\Users\\27933\\AppData\\Local\\Temp\\workbench-e2e-VAKSgQ\\.workbench",
	},
];

/*
 * 记录型种类（门，TF-0161 候选 D）＝ git 监视 / human 编辑器，见 `RECORDING_KINDS`
 * 的 import：与产品代码共用同一份定义（`landmark-set.ts`），这样预演数字与落库读数
 * 不会因为各自维护一份常量而悄悄分家。预演叠加门，因为切换顺序是「先门后尺」。
 */

/** 默认抽样（tf-0159 §2.3）：全量 84 会话 × 3 = 188 条人评不了，默认只问 5 个会话。 */
const SAMPLE_N_DEFAULT = 5;

function sessionClock(events: InteractionEvent[]): number {
	let latest = 0;
	for (const event of events) {
		const at = Date.parse(event.time);
		if (Number.isFinite(at) && at > latest) latest = at;
	}
	return latest > 0 ? latest : Date.now();
}

interface WriterInfo {
	id: string;
	kind: string;
	events: InteractionEvent[];
}

async function loadWriters(path: string): Promise<WriterInfo[]> {
	const bb = openBlackboard(path);
	const writers = await bb.sessions.list();
	const records = await bb.events.query({
		source: INTERACTIONS_SOURCE,
		type: INTERACTIONS_TYPE,
	});
	const byOrigin = new Map<string, InteractionEvent[]>();
	for (const record of records) {
		const item = record.payload as Partial<InteractionEvent> | null;
		if (!item?.origin || typeof item.handle !== "string") continue;
		const list = byOrigin.get(item.origin) ?? [];
		list.push(item as InteractionEvent);
		byOrigin.set(item.origin, list);
	}
	return writers.map((w) => ({
		id: w.id,
		kind: w.kind,
		events: byOrigin.get(w.id) ?? [],
	}));
}

/** 相对口径下某写者的文件级 top-K（会话时钟），与 context.ts sessionFileTopK 同义。 */
function fileTopK(
	events: InteractionEvent[],
	k: number,
): Array<{ handle: string; doi: number }> {
	const result = computeDoi(events, sessionClock(events), DEFAULT_DOI_CONFIG);
	return [...result.scores.values()]
		.filter((s) => s.contentType === "file")
		.sort((a, b) => b.doi - a.doi || a.handle.localeCompare(b.handle))
		.slice(0, k)
		.map((s) => ({ handle: s.handle, doi: s.doi }));
}

/** 阈值口径：该写者的文件级地标（会话时钟，DOI>10）。 */
function thresholdFileLandmarks(events: InteractionEvent[]): string[] {
	const result = computeDoi(events, sessionClock(events), DEFAULT_DOI_CONFIG);
	return result.landmarks.filter(
		(h) => result.scores.get(h)?.contentType === "file",
	);
}

interface RehearsalReport {
	site: string;
	exists: boolean;
	/** 门+阈值口径（旧读数，历史可比） */
	threshold: {
		agentWriters: number;
		fileLandmarks: number;
		endorsed: number;
		endorsedShare: number | null;
	};
	/** 门+相对口径（新读数） */
	relative: {
		k: number;
		sessionsWithSet: number;
		items: number;
		distinctHandles: number;
		/** 相对口径下的抽样预演 */
		sample: {
			n: number;
			totalSessions: number;
			/** 抽样后实际问数（Σ top-k 条数，截断在 N 个会话） */
			questions: number;
			/** 抽样会话的选择依据：DOI 总分降序（tf-0159 §2.3 按会话 DOI 从高到低）。 */
			basis: string;
		};
	};
	/** 结论连续性（tf-0159 §2.2）：门+相对口径下旧复核结论的去向。 */
	continuity: {
		reviewsTotal: number;
		inSet: number;
		legacy: number;
		/** 逐条 legacy 列表（前 10 条，供决策者人工核对） */
		legacySamples: string[];
	};
}

async function rehearse(
	label: string,
	path: string,
	k: number,
	sampleN: number,
): Promise<RehearsalReport> {
	if (!existsSync(path)) {
		return {
			site: label,
			exists: false,
			threshold: {
				agentWriters: 0,
				fileLandmarks: 0,
				endorsed: 0,
				endorsedShare: null,
			},
			relative: {
				k,
				sessionsWithSet: 0,
				items: 0,
				distinctHandles: 0,
				sample: { n: sampleN, totalSessions: 0, questions: 0, basis: "" },
			},
			continuity: { reviewsTotal: 0, inSet: 0, legacy: 0, legacySamples: [] },
		};
	}
	const writers = await loadWriters(path);
	// 门：记录型种类不进候选
	const candidates = writers.filter(
		(w) => !RECORDING_KINDS.has(w.kind) && w.events.length > 0,
	);
	// 旧读数（阈值口径，门后）：历史可比基线
	let fileLandmarks = 0;
	for (const w of candidates) {
		fileLandmarks += thresholdFileLandmarks(w.events).length;
	}
	// 复核结论（human + steward 都算「已有结论」，各有各的读数行）
	const bb = openBlackboard(path);
	const allEvents = await bb.events.query({});
	const humanReviews = collectLandmarkReviews(allEvents, "human");
	const stewardReviews = collectLandmarkReviews(allEvents, "steward");
	const reviewsTotal = humanReviews.length + stewardReviews.length;

	// 新读数（相对口径，门后）
	let sessionsWithSet = 0;
	let items = 0;
	const handles = new Set<string>();
	const newSetPairs = new Set<string>(); // "writer\u0000handle"
	for (const w of candidates) {
		const top = fileTopK(w.events, k);
		if (top.length === 0) continue;
		sessionsWithSet += 1;
		items += top.length;
		for (const s of top) {
			handles.add(s.handle);
			newSetPairs.add(`${w.id}\u0000${s.handle}`);
		}
	}
	// 抽样预演（tf-0159 §2.3）：按会话 DOI 总分降序取前 N 个
	const sessionScores = candidates.map((w) => ({
		id: w.id,
		kind: w.kind,
		totalDoi: fileTopK(w.events, 999).reduce((s, x) => s + x.doi, 0),
	}));
	sessionScores.sort(
		(a, b) => b.totalDoi - a.totalDoi || a.id.localeCompare(b.id),
	);
	const sampled = sessionScores.slice(0, sampleN);
	const questions = sampled.reduce((sum, s) => {
		const w = candidates.find((c) => c.id === s.id)!;
		return sum + Math.min(k, fileTopK(w.events, 999).length);
	}, 0);

	// 结论连续性（tf-0159 §2.2）
	let inSet = 0;
	const legacyList: string[] = [];
	for (const review of [...humanReviews, ...stewardReviews]) {
		const key = `${review.writer}\u0000${review.handle}`;
		if (newSetPairs.has(key)) inSet += 1;
		else
			legacyList.push(
				`${review.writer.slice(0, 10)}…/${review.handle} [${review.verdict}]`,
			);
	}
	return {
		site: label,
		exists: true,
		threshold: {
			agentWriters: candidates.filter((w) => w.kind === "agent").length,
			fileLandmarks,
			endorsed: 0,
			endorsedShare: fileLandmarks > 0 ? 0 : null,
		},
		relative: {
			k,
			sessionsWithSet,
			items,
			distinctHandles: handles.size,
			sample: {
				n: sampleN,
				totalSessions: sessionScores.length,
				questions,
				basis: "会话 DOI 总分降序（tf-0159 §2.3）",
			},
		},
		continuity: {
			reviewsTotal,
			inSet,
			legacy: legacyList.length,
			legacySamples: legacyList.slice(0, 10),
		},
	};
}

const siteFilter = at("--site");
const targets = siteFilter
	? SITES.filter((s) => s.label === siteFilter)
	: SITES;
if (siteFilter && targets.length === 0) {
	console.error(
		`未知现场：${siteFilter}（可选：${SITES.map((s) => s.label).join(", ")}）`,
	);
	process.exit(2);
}
const k = Number(at("--top-k") ?? "3");
const sampleN = Number(at("--sample-n") ?? String(SAMPLE_N_DEFAULT));

const reports = await Promise.all(
	targets.map((site) => rehearse(site.label, site.path, k, sampleN)),
);

if (argv.includes("--json")) {
	console.log(
		JSON.stringify(
			{ measuredAt: new Date().toISOString(), k, sampleN, sites: reports },
			null,
			1,
		),
	);
} else {
	for (const r of reports) {
		if (!r.exists) {
			console.log(`\n[${r.site}] 黑板不存在——本轮缺现场，不冒充完整。`);
			continue;
		}
		console.log(`\n===== ${r.site} =====`);
		console.log("  双读数（先门后尺：git/human 不进候选）");
		console.log(
			`    旧·阈值口径 endorsedShare：分母（门后文件级地标）= ${r.threshold.fileLandmarks} 条${r.threshold.fileLandmarks === 0 ? " → 不可计算（空集）" : ""}`,
		);
		console.log(
			`    新·相对口径 top-${r.relative.k}：有集合写者 ${r.relative.sessionsWithSet} · 条目 ${r.relative.items} · 去重 handle ${r.relative.distinctHandles}`,
		);
		console.log("  抽样预演（tf-0159 §2.3）");
		console.log(
			`    默认每队列只问 ${r.relative.sample.n}/${r.relative.sample.totalSessions} 个会话（${r.relative.sample.basis}）→ 实际问数 ${r.relative.sample.questions} 条`,
		);
		console.log("  结论连续性（tf-0159 §2.2）");
		console.log(
			`    已有复核结论 ${r.continuity.reviewsTotal} 条：落在新集合 ${r.continuity.inSet} 条 · 变 legacy ${r.continuity.legacy} 条（不删除、不改判）`,
		);
		for (const s of r.continuity.legacySamples.slice(0, 5)) {
			console.log(`      legacy 例：${s}`);
		}
	}
}

/* ==================== 附注：预演不切产品代码 ==================== */
/*
 * 本脚本只做「切了会怎样」的数字预演，不动 currentLandmarkAcceptance / 队列 / CLI。
 * 真正切换时的动作（文档 §2 的三个决定 + 回滚开关 LandmarkDenominator 参数）由
 * 后续节点按 TF-0159 的验收推进，预演读数就是它的数据依据。
 */
