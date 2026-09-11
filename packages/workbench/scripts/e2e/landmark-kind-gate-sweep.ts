/**
 * TF-0161 候选 D·种类门测量（决策者口径：门是证据，不是修复）。
 *
 * 为什么需要它：TF-0161 §2c 量出「100% 文件级阈值地标来自 git 监视会话」——
 * DOI 按会话算，监视会话的「全部工作」就是在少数文件上反复落笔，而 agent 会话
 * 的触碰是分散的（多文件各碰一两次，每条都过不了 10 分线）。门是否打得准、打
 * 了之后空集是否得救、真信号是否被误杀——这三件事都要量，不能靠推理宣称。
 *
 * 三张表：
 *   表一（诊断）：加门前按会话种类分组，看每个文件的 DOI 推手（门的核心依据）。
 *   表二（效果）：门前后 × 阈值/相对两口径的对比矩阵（四现场）。
 *   表三（回归门）：构造「真实重复编辑 + 有声明产物」的 agent 会话，门后它仍要
 *     产出地标——防止门为了清噪声把真信号一起杀掉（TF-0161 验收 3）。
 *
 * 判据：种类门只认 writer.kind（git / human = 记录型），不看内容、不看频率——
 * 这是最窄、最不容易误杀的门。产物判据（steward 声明）在四个现场全部无区分度
 * （84/84 会话 0 声明产物，TF-0161 §2c 已测），所以不作为门条件。
 *
 * 用法：
 *   bun scripts/e2e/landmark-kind-gate-sweep.ts                     # 四现场全跑
 *   bun scripts/e2e/landmark-kind-gate-sweep.ts --json               # 机器可读
 *   bun scripts/e2e/landmark-kind-gate-sweep.ts --site live-tenant   # 单现场
 */

import { existsSync } from "node:fs";
import { openBlackboard } from "../../src/blackboard";
import { computeDoi, DEFAULT_DOI_CONFIG } from "../../src/interactions/doi";
import { RECORDING_WRITER_KINDS as RECORDING_KINDS } from "../../src/interactions/landmark-set";
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

/**
 * 现成现场：TF-0161 §2c 四个 + 2026-09-11 两个真实 live-run（缺一即报）。
 *
 * 落盘纪律（2026-09-11 实测教训）：TEMP 里的现场会被清理掉（`workbench-e2e-*`
 * 数小时内消失），所以**凡要反复引用的现场一律放仓库内
 * `packages/workbench/.evidence-sites/<label>/`**，SITES 只指向落盘路径。
 * TEMP 只作当轮诊断的临时位置，不作为长期引用目标。
 */
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
	{
		// 2026-09-11 第一轮 live-run：首个「模型自主开发」会话（reader/writer 双线程 +
		// 独立验收打回重改），interactions 首次非空。已从 TEMP 落盘归档。
		label: "VAS1EM（live-run 1）",
		path: "D:\\helmor-main\\packages\\workbench\\.evidence-sites\\live-run-2026-09-11-VAS1EM\\.workbench",
	},
	{
		// 2026-09-11 第二轮 live-run：修掉整轮/单 hop 预算 bug 后**首次整轮通过**
		// （模型响应 43 · 请求尝试 44 · http-error 仅 1 次且被有界重试兜住）。
		// 样本窗口三格首次全齐（restores 7 / noticeOutcomes 8 / sealDecisions 6），
		// 是「真实多文件开发会让相对口径信息量上升」的最强现场。
		label: "1OioVM（live-run 2）",
		path: "D:\\helmor-main\\packages\\workbench\\.evidence-sites\\live-run-2026-09-11-1OioVM\\.workbench",
	},
];

/*
 * 记录型种类（门要排除的）＝ git 监视 / human 编辑器，见 `RECORDING_KINDS` 的 import：
 * 常量与产品代码共用同一份定义（`landmark-set.ts`），本脚本只**量**，不改产品行为。
 * 门只作用于 L1 候选，不动实时上下文显示——实时显示里「git 刚刚改过这个文件」是
 * 有用的信息，它不该被当成「这次干活的核心」而已。
 */

/** 会话时钟：L1 判定路径的口径（参考时刻 = 该写者自己最后一条事件）。 */
function sessionClock(events: InteractionEvent[]): number {
	let latest = 0;
	for (const event of events) {
		const at = Date.parse(event.time);
		if (Number.isFinite(at) && at > latest) latest = at;
	}
	return latest > 0 ? latest : Date.now();
}

/** 表一的一行：某个会话种类在该现场的阈值地标贡献与触碰总量。 */
interface KindRow {
	kind: string;
	sessions: number;
	/** 该种类全部会话的触碰次数（不含 interest-reduced）。 */
	touches: number;
	/** 该种类全部会话合计的文件级阈值地标条数（每写者各算各的 DOI，不合并会话）。 */
	fileLandmarks: number;
	fileHandles: string[];
}

function kindTable(
	writers: Array<{ id: string; kind: string }>,
	byWriter: Map<string, InteractionEvent[]>,
): KindRow[] {
	const kinds = [...new Set(writers.map((w) => w.kind))];
	const rows: KindRow[] = [];
	for (const kind of kinds) {
		let sessions = 0;
		let touches = 0;
		let fileLandmarks = 0;
		const fileHandles = new Set<string>();
		for (const writer of writers) {
			if (writer.kind !== kind) continue;
			const events = byWriter.get(writer.id) ?? [];
			const real = events.filter((e) => e.kind !== "interest-reduced");
			sessions += 1;
			touches += real.length;
			if (real.length === 0) continue;
			const result = computeDoi(
				events,
				sessionClock(events),
				DEFAULT_DOI_CONFIG,
			);
			for (const handle of result.landmarks) {
				if (result.scores.get(handle)?.contentType !== "file") continue;
				fileLandmarks += 1;
				fileHandles.add(handle);
			}
		}
		rows.push({
			kind,
			sessions,
			touches,
			fileLandmarks,
			fileHandles: [...fileHandles],
		});
	}
	return rows.sort(
		(a, b) => b.fileLandmarks - a.fileLandmarks || a.kind.localeCompare(b.kind),
	);
}

/* ==================== 表二：门前后 × 两口径 ==================== */

interface DenominatorSpec {
	label: string;
	gated: boolean;
	mode: "threshold" | "relative";
}

const DENOMINATORS: DenominatorSpec[] = [
	{ label: "阈值口径（DOI>10）", gated: false, mode: "threshold" },
	{ label: "阈值口径 + 种类门", gated: true, mode: "threshold" },
	{ label: "相对口径 top-3（无门）", gated: false, mode: "relative" },
	{ label: "相对口径 top-3 + 种类门", gated: true, mode: "relative" },
];

interface EffectRow {
	label: string;
	gated: boolean;
	mode: string;
	/** 阈值口径：文件级地标条数（每写者各算各的，加总）。 */
	fileLandmarks: number;
	/** 相对口径：非空集合写者数（有文件级触碰的写者中 top-3 非空）。 */
	sessionsWithSet: number;
	/** 相对口径：条目总数（Σ top-3 条数）。 */
	items: number;
	handles: string[];
	/** 门槛后为空集（且加门前三现场已是空集）——「门不生产地标」的直接读数。 */
	gatedOutLandsmarks: number;
}

function effectTable(
	writers: Array<{ id: string; kind: string }>,
	byWriter: Map<string, InteractionEvent[]>,
): EffectRow[] {
	const rows: EffectRow[] = [];
	for (const spec of DENOMINATORS) {
		let fileLandmarks = 0;
		let sessionsWithSet = 0;
		let items = 0;
		const handles = new Set<string>();
		for (const writer of writers) {
			// 门：记录型种类不进候选
			if (spec.gated && RECORDING_KINDS.has(writer.kind)) continue;
			const events = byWriter.get(writer.id) ?? [];
			if (events.length === 0) continue;
			if (spec.mode === "threshold") {
				const result = computeDoi(
					events,
					sessionClock(events),
					DEFAULT_DOI_CONFIG,
				);
				for (const handle of result.landmarks) {
					if (result.scores.get(handle)?.contentType !== "file") continue;
					fileLandmarks += 1;
					handles.add(handle);
				}
			} else {
				const result = computeDoi(
					events,
					sessionClock(events),
					DEFAULT_DOI_CONFIG,
				);
				const top = [...result.scores.values()]
					.filter((s) => s.contentType === "file")
					.sort((a, b) => b.doi - a.doi || a.handle.localeCompare(b.handle))
					.slice(0, 3);
				if (top.length > 0) sessionsWithSet += 1;
				items += top.length;
				for (const s of top) handles.add(s.handle);
			}
		}
		rows.push({
			label: spec.label,
			gated: spec.gated,
			mode: spec.mode,
			fileLandmarks,
			sessionsWithSet,
			items,
			handles: [...handles].sort(),
			gatedOutLandsmarks: 0,
		});
	}
	// 门清掉了多少：无门阈值行 - 门后阈值行
	const noGate = rows.find((r) => r.mode === "threshold" && !r.gated);
	const gated = rows.find((r) => r.mode === "threshold" && r.gated);
	if (noGate && gated)
		gated.gatedOutLandsmarks = Math.max(
			0,
			noGate.fileLandmarks - gated.fileLandmarks,
		);
	return rows;
}

/* ==================== 表三：回归门（不误杀真信号） ==================== */

/**
 * 表三·回归门（TF-0161 验收 3「不误杀真信号」）。
 *
 * 断言对象是**门的行为**，不是阈值：
 *   A. agent 会话（真实工作形状：多文件分散编辑）：门前后文件级地标集合**完全一致**
 *      ——门按 kind 放行，绝不能因内容/频率误杀。
 *   B. git 监视会话（重复落笔同文件）：门后集合为空——门确实清噪声。
 *   C. 分散形状读数（附加证据，非断言）：agent 4 文件 11 次编辑在**阈值口径**下
 *      文件级地标为 0——这不是门杀的，是阈值口径对分散触碰结构性不适用的直接读数
 *      （TF-0159 升为必须的证据路径）。相对口径下同一会话 top-3 全是真任务文件。
 */
function regressionCase(): {
	description: string;
	agentEvents: InteractionEvent[];
	gitEvents: InteractionEvent[];
} {
	const base = Date.now() - 120_000;
	// A. agent 真实工作形状：4 文件 11 次编辑，间隔 5s（分散=真实，集中=fixture 噪声）
	const plan: Array<[string, number]> = [
		["src/auth.ts", 4],
		["src/session.ts", 3],
		["src/api.ts", 2],
		["src/utils.ts", 2],
	];
	const agentEvents: InteractionEvent[] = [];
	let t = base;
	for (const [handle, count] of plan) {
		for (let i = 0; i < count; i += 1) {
			t += 5000;
			agentEvents.push({
				time: new Date(t).toISOString(),
				kind: "edit",
				origin: "agent-synthetic-regress",
				contentType: "file",
				handle,
				delta: 12,
			});
		}
	}
	// B. git 监视形状：同两个文件各 25 次 edit（live-tenant 实测形状）
	const gitEvents: InteractionEvent[] = [];
	let g = base;
	for (const handle of ["src/alpha.ts", "src/beta.ts"]) {
		for (let i = 0; i < 25; i += 1) {
			g += 5000;
			gitEvents.push({
				time: new Date(g).toISOString(),
				kind: "edit",
				origin: "git-synthetic",
				contentType: "file",
				handle,
				delta: 12,
			});
		}
	}
	return {
		description:
			"agent 4 文件 11 次编辑（分散）vs git 2 文件 50 次 edit（live-tenant 实测形状）",
		agentEvents,
		gitEvents,
	};
}

function fileLandmarksOf(events: InteractionEvent[]): string[] {
	const result = computeDoi(events, sessionClock(events), DEFAULT_DOI_CONFIG);
	return result.landmarks.filter(
		(h) => result.scores.get(h)?.contentType === "file",
	);
}

/** 门模拟：RECORDING_KINDS 里的种类被排除，其余照旧。 */
function gateSim(kind: string, landmarks: string[]): string[] {
	return RECORDING_KINDS.has(kind) ? [] : landmarks;
}

/** 表三判定：A/B 是断言，C 是读数（C 不是断言，因为「阈值救不了分散形状」是结论而非期望）。 */
function regressionVerdict(
	agentEvents: InteractionEvent[],
	gitEvents: InteractionEvent[],
): {
	caseA: { passed: boolean; detail: string };
	caseB: { passed: boolean; detail: string };
	caseC: { thresholdRead: number; relativeRead: string[] };
} {
	// A. agent 门前后一致
	const agentLm = fileLandmarksOf(agentEvents);
	const agentGated = gateSim("agent", agentLm);
	const caseA = {
		passed: agentGated.length === agentLm.length,
		detail:
			agentGated.length === agentLm.length
				? `门前后一致（${agentLm.length} 条）`
				: `门误杀：门前 ${agentLm.length} 条 → 门后 ${agentGated.length} 条`,
	};
	// B. git 门后为空
	const gitLm = fileLandmarksOf(gitEvents);
	const gitGated = gateSim("git", gitLm);
	const caseB = {
		passed: gitGated.length === 0,
		detail:
			gitLm.length === 0
				? `git 会话门前即无地标，门无所清（此形状不适用）`
				: `门前 ${gitLm.length} 条 → 门后 ${gitGated.length} 条`,
	};
	// C. 分散形状读数（阈值口径 vs 相对口径）
	const agentResult = computeDoi(
		agentEvents,
		sessionClock(agentEvents),
		DEFAULT_DOI_CONFIG,
	);
	const relativeTop = [...agentResult.scores.values()]
		.filter((s) => s.contentType === "file")
		.sort((a, b) => b.doi - a.doi || a.handle.localeCompare(b.handle))
		.slice(0, 3)
		.map((s) => `${s.handle}(${s.doi.toFixed(1)})`);
	return {
		caseA,
		caseB,
		caseC: { thresholdRead: agentLm.length, relativeRead: relativeTop },
	};
}

/* ==================== 主流程 ==================== */

interface SiteReport {
	site: string;
	exists: boolean;
	writersTotal: number;
	interactionsTotal: number;
	kindRows: KindRow[];
	effectRows: EffectRow[];
	recordingShare: number | null;
}

async function measureSite(label: string, path: string): Promise<SiteReport> {
	if (!existsSync(path)) {
		return {
			site: label,
			exists: false,
			writersTotal: 0,
			interactionsTotal: 0,
			kindRows: [],
			effectRows: [],
			recordingShare: null,
		};
	}
	const bb = openBlackboard(path);
	const writers = await bb.sessions.list();
	const records = await bb.events.query({
		source: INTERACTIONS_SOURCE,
		type: INTERACTIONS_TYPE,
	});
	const byWriter = new Map<string, InteractionEvent[]>();
	for (const record of records) {
		const item = record.payload as Partial<InteractionEvent> | null;
		if (!item?.origin || typeof item.handle !== "string") continue;
		const list = byWriter.get(item.origin) ?? [];
		list.push(item as InteractionEvent);
		byWriter.set(item.origin, list);
	}
	const writerInfos = writers.map((w) => ({ id: w.id, kind: w.kind }));
	const kindRows = kindTable(writerInfos, byWriter);
	const effectRows = effectTable(writerInfos, byWriter);
	// 记录型占比（表一核心读数）
	const lmTotal = kindRows.reduce((s, r) => s + r.fileLandmarks, 0);
	const lmRecording = kindRows
		.filter((r) => RECORDING_KINDS.has(r.kind))
		.reduce((s, r) => s + r.fileLandmarks, 0);
	return {
		site: label,
		exists: true,
		writersTotal: writers.length,
		interactionsTotal: records.length,
		kindRows,
		effectRows,
		recordingShare: lmTotal > 0 ? lmRecording / lmTotal : null,
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

const reports = await Promise.all(
	targets.map((site) => measureSite(site.label, site.path)),
);

const regress = regressionCase();
const regressVerdict = regressionVerdict(
	regress.agentEvents,
	regress.gitEvents,
);
const regressPassed =
	regressVerdict.caseA.passed && regressVerdict.caseB.passed;

if (argv.includes("--json")) {
	console.log(
		JSON.stringify(
			{
				measuredAt: new Date().toISOString(),
				sites: reports,
				regression: {
					description: regress.description,
					passed: regressPassed,
					caseA: regressVerdict.caseA,
					caseB: regressVerdict.caseB,
					caseC: regressVerdict.caseC,
				},
			},
			null,
			1,
		),
	);
} else {
	for (const report of reports) {
		if (!report.exists) {
			console.log(
				`\n[${report.site}] 黑板不存在（${targetPath(report)}）——本轮测量缺现场，不冒充完整。`,
			);
			continue;
		}
		console.log(
			`\n===== ${report.site}（写者 ${report.writersTotal} · interaction 事件 ${report.interactionsTotal}）=====`,
		);
		// 表一
		console.log("  表一·门之前——谁在贡献阈值地标（按会话种类）");
		for (const row of report.kindRows) {
			console.log(
				`    ${row.kind.padEnd(6)} 会话 ${String(row.sessions).padStart(3)} · 触碰 ${String(row.touches).padStart(4)} 次 · 文件级阈值地标 ${String(row.fileLandmarks).padStart(2)} 条${row.fileHandles.length > 0 ? ` · ${row.fileHandles.join(", ")}` : ""}`,
			);
		}
		if (report.recordingShare !== null) {
			console.log(
				`    → 记录型种类（git/human）贡献 ${Math.round(report.recordingShare * 100)}% 的文件级阈值地标`,
			);
		}
		// 表二
		console.log("  表二·门前后对比");
		for (const row of report.effectRows) {
			if (row.mode === "threshold") {
				console.log(
					`    ${row.label.padEnd(24)} 文件级地标 ${String(row.fileLandmarks).padStart(3)} 条 · 清掉 ${String(row.gatedOutLandsmarks).padStart(3)} 条${row.handles.length > 0 ? ` · ${row.handles.join(", ")}` : ""}`,
				);
			} else {
				console.log(
					`    ${row.label.padEnd(24)} 非空集合写者 ${String(row.sessionsWithSet).padStart(3)} · 条目 ${String(row.items).padStart(4)} 条 · 去重 handle ${String(row.handles.length).padStart(2)}${row.handles.length > 0 ? ` [${row.handles.slice(0, 6).join(", ")}]` : ""}`,
				);
			}
		}
	}
	// 表三
	console.log(`\n===== 表三·回归门（不误杀真信号，TF-0161 验收 3）=====`);
	console.log(`  用例：${regress.description}`);
	console.log(
		`  A. agent 门前后一致：${regressVerdict.caseA.passed ? "✓" : "✗"} ${regressVerdict.caseA.detail}`,
	);
	console.log(
		`  B. git 门后清空：${regressVerdict.caseB.passed ? "✓" : "✗"} ${regressVerdict.caseB.detail}`,
	);
	console.log(
		`  C. 分散形状读数（非断言）：阈值口径文件级地标 ${regressVerdict.caseC.thresholdRead} 条；相对口径 top-3 = ${regressVerdict.caseC.relativeRead.join(", ")}`,
	);
	if (!regressPassed) process.exitCode = 1;
}

function targetPath(report: SiteReport): string {
	return SITES.find((s) => s.label === report.site)?.path ?? "";
}

/* ==================== 表二·附：门加进产品代码后的断裂检查（已落地，2026-09-11） ==================== */
/*
 * 本脚本当初预留的这条检查已经执行完毕，结论记在这里而不是删掉：
 *
 * 1. 种类门已进 `currentLandmarkAcceptance` / `relativeLandmarkCoverage`（分母侧）
 *    与 `reviewLandmark` 的接受集合（回填侧），两侧共用 `landmark-set.ts` 的同一份
 *    实现——这正是当初担心的「展示一套口径、校验另一套」的断点。
 * 2. 门槛口后阈值集合为空 → 分母被推到 0 → 不可计算。这条在切换分母时被处理：
 *    默认读数切到每会话文件级 top-K，阈值口径读数并报一个周期（TF-0159 §2.1）。
 * 3. 回填通道不会断：接受集合是「阈值候选 ∪ 相对候选 ∪ 投影表」，双读数期两条
 *    尺子展示出来的条目都能回填。回归门见 src/interactions/landmark-set.test.ts。
 *
 * 本脚本仍然只量、不改产品代码；上面的结论由产品代码与该测试文件断言。
 */
