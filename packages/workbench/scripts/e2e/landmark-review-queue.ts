/**
 * TF-0057 L1 · 自然证据的快速通道：把「等地标被认可」变成一份可过一遍的队列。
 *
 * 为什么需要它：L1 的判据是「地标集合里 80% 以上是用户认可的核心」，这条读数
 * 只能由人产生——脚本或模型安排的手势会把读数收敛到脚本里的常数（2026-09-10
 * 实测 0.08，且随每轮新增地标继续下降），所以它不可能靠采样「等出来」。
 * 能做的只有一件事：把人的成本压到最低——先算清楚有哪些地标、哪些还没复核、
 * 每条长什么样，人只需回答 endorse / reject。
 *
 * 2026-09-11 迁移（TF-0159 + TF-0161 候选 D）：
 *   - 队列落在**门后相对口径**（每会话文件级 top-K）。门后阈值口径在四个真实现场
 *     全部归零，队列会是空的——那正是「切分母」的证据，不是可以把人叫来的东西。
 *   - 默认按会话抽样 N=5（会话 DOI 总分降序）。全量 83 会话 × 3 = 192 条人评不了，
 *     读数里明写 `sampledSessions: 5/83`，**绝不把抽样写成全量覆盖**。
 *   - 旧结论落在新集合之外的只计数（legacy），不删除、不改判。
 *
 * 用法：
 *   bun scripts/e2e/landmark-review-queue.ts                       # 打印队列（抽样 5 会话）
 *   bun scripts/e2e/landmark-review-queue.ts --all-sessions        # 全量（不再抽样）
 *   bun scripts/e2e/landmark-review-queue.ts --unfiltered          # 回滚：未过滤集合出题
 *   bun scripts/e2e/landmark-review-queue.ts --out ../../docs/landmark-review-queue.md
 *   bun scripts/e2e/landmark-review-queue.ts --template answers.json
 *   bun scripts/e2e/landmark-review-queue.ts --apply answers.json
 *
 * 回滚开关：`--denominator threshold` 用回旧的那把尺子（DOI>10 的文件级集合），
 * 不重新发明第二套展示逻辑——尺子只有一把，由 landmark-set.ts 提供。
 *
 * 队列只读：不加 --apply 时它不改黑板。回填走的也是 CLI 同一支手势（human 来源、
 * 只对候选集合有效），所以人回答过的部分才会进 L1 的分母。
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openBlackboard } from "../../src/blackboard";
import {
	interestFromEvents,
	sessionFileScores,
} from "../../src/interactions/context";
import {
	DEFAULT_LANDMARK_TOP_K,
	isRecordingWriter,
	type LandmarkDenominator,
	landmarkCandidates,
	type WriterRef,
} from "../../src/interactions/landmark-set";
import {
	collectLandmarkReviews,
	type LandmarkReviewSource,
	landmarkReviewJudgement,
	reviewLandmark,
} from "../../src/interactions/review";
import { currentLandmarkAcceptance } from "../../src/interactions/review-stats";
import {
	INTERACTIONS_SOURCE,
	INTERACTIONS_TYPE,
} from "../../src/interactions/types";

const argv = Bun.argv.slice(2);
const at = (flag: string): string | undefined => {
	const index = argv.indexOf(flag);
	return index >= 0 ? (argv[index + 1] as string | undefined) : undefined;
};
const has = (flag: string): boolean => argv.includes(flag);

const workspace = at("--workspace");
const blackboardAt = at("--blackboard")
	? resolve(at("--blackboard") as string)
	: workspace
		? resolve(workspace, ".workbench")
		: null;
if (!blackboardAt) {
	console.error("需要 --workspace <租户> 或 --blackboard <.workbench 目录>");
	process.exit(2);
}

/** 默认口径是**相对口径**：门后阈值口径在四个现场全空，队列会没人可审。 */
const denominator: LandmarkDenominator =
	at("--denominator") === "threshold" ? "threshold" : "session-top-k";
const topK = Number(at("--top-k") ?? String(DEFAULT_LANDMARK_TOP_K));
/**
 * 「只认可落笔」口径（TF-0161 后续）：**2026-09-11 已翻默认**——队列默认按
 * 过滤后的集合出题（条目级过滤 + 只读会话豁免，`DEFAULT_REQUIRE_EDITS = true`）。
 * 回滚开关 `--unfiltered` 用翻默认前的未过滤集合出题（对照用）。
 * 过滤后的集合是未过滤集合的子集，所以两种口径出的每一条都回填得进去
 * （reviewLandmark 的接受集是两口径候选 ∪ 投影表）。
 */
const unfiltered = has("--unfiltered");
const requireEdits = !unfiltered;
/** 默认抽样 5 个会话（tf-0159 §2.3）：全量 192 条人评不了，15 条在十分钟预算内。 */
const sampleN = Number(at("--sample-n") ?? "5");
const allSessions = has("--all-sessions");

interface QueueRow {
	writer: string;
	handle: string;
	summary: string;
	current: "endorse" | "reject" | null;
}

const pairKey = (writer: string, handle: string): string =>
	`${writer}\u0000${handle}`;

/**
 * 从投影里取这条候选的摘要：折叠进父目录的子条目只出现在父条目的 collapsed
 * 文本里（`handle（DOI x，编辑 2 次 · …）`），取不到就留空——队列宁可少一句话，
 * 也不自己编一句。
 *
 * 投影必须走**会话时钟**：这对摘要也是口径问题。实时上下文显示用「现在」是对的
 * （几天没碰的文件就该离开上下文），但队列列的是「这段会话干的核心」，用「现在」
 * 算的话列表里的条目会和投影对不上，于是摘要整列空白——人评的时候看不到东西，
 * 又不敢自己去猜。
 */
function summaryFor(
	interest: ReturnType<typeof interestFromEvents>,
	handle: string,
): string {
	const direct = interest.landmarks.find(
		(landmark) => landmark.handle === handle,
	);
	if (direct) return direct.summary;
	for (const landmark of interest.landmarks) {
		const folded = landmark.collapsed.find((entry) =>
			entry.startsWith(`${handle}（`),
		);
		if (folded) return folded.slice(handle.length + 1).replace(/^（|）$/g, "");
	}
	return "";
}

function hasDirectoryTouch(events: unknown[], writer: string): boolean {
	return events.some((event) => {
		const record = event as {
			source?: string;
			type?: string;
			payload?: { origin?: string; contentType?: string };
		};
		return (
			record.source === INTERACTIONS_SOURCE &&
			record.type === INTERACTIONS_TYPE &&
			record.payload?.origin === writer &&
			record.payload.contentType === "directory"
		);
	});
}

interface QueueReport {
	bb: Awaited<ReturnType<typeof openBlackboard>>;
	rows: QueueRow[];
	writerRefs: WriterRef[];
	/** 门后有文件级候选的会话数（全站）——抽样分母。 */
	candidateSessions: number;
	/** 本次读数实际覆盖的会话数。 */
	sampledSessions: number;
	/** 写者总数（含被门排除的）。 */
	writersTotal: number;
	/** 被种类门排除的写者数（git/human）。 */
	gatedWriters: number;
	/** 非门写者里排不出任何文件级候选的个数（这一层没触发）。 */
	starvedWriters: number;
	/** 上面这些里只碰过目录、一个文件都没碰的个数（标定信号）。 */
	directoryOnlyWriters: number;
	/** 门后**阈值口径**还剩几条文件级地标：本轮实测 0，是切口径的依据。 */
	thresholdFileLandmarks: number;
	/** 本次读数（只含被抽中的会话）。 */
	judgement: {
		total: number;
		reviewed: number;
		endorsed: number;
		rejected: number;
		endorsedShare: number | null;
		reviewedCoverage: number | null;
	};
	/** 结论连续性：落在新集合外的一律 legacy，保留不改判。 */
	legacy: {
		human: number;
		steward: number;
		inSetHuman: number;
		inSetSteward: number;
	};
	/** 待复核的条数（本次读数的范围内）。 */
	pending: number;
}

async function buildQueue(): Promise<QueueReport> {
	const bb = openBlackboard(blackboardAt as string);
	const [writers, events] = await Promise.all([
		bb.sessions.list(),
		bb.events.all(),
	]);
	const humanReviews = collectLandmarkReviews(events, "human");
	const stewardReviews = collectLandmarkReviews(events, "steward");
	const latest = new Map<string, "endorse" | "reject">();
	for (const review of humanReviews)
		latest.set(pairKey(review.writer, review.handle), review.verdict);

	// 候选会话（全站，先门后尺）：抽样与 legacy 计数都建立在全量之上，抽样只影响
	// 「这一轮问多少」，不影响「旧结论算不算落进新集合」。
	interface Candidate {
		writer: WriterRef;
		handles: string[];
		score: number;
	}
	const candidates: Candidate[] = [];
	let gatedWriters = 0;
	let starvedWriters = 0;
	let directoryOnlyWriters = 0;
	let thresholdFileLandmarks = 0;
	for (const writer of writers) {
		const ref: WriterRef = { id: writer.id, kind: writer.kind };
		// 门：git 监视 / human 编辑器记录的是「文件被动过」，不是「这次干的活是什么」。
		if (isRecordingWriter(ref)) {
			gatedWriters += 1;
			continue;
		}
		const handles = landmarkCandidates(events, writer.id, {
			denominator,
			topK,
			requireEdits,
		});
		// 标定信号：门后阈值口径还剩几条。本轮四现场实测 = 0，这就是切分母的依据，
		// 它必须一直看得见——否则「为什么用相对口径」半年后就没人说得清了。
		thresholdFileLandmarks += landmarkCandidates(events, writer.id, {
			denominator: "threshold",
		}).length;
		if (handles.length === 0) {
			if (hasDirectoryTouch(events, writer.id)) directoryOnlyWriters += 1;
			else starvedWriters += 1;
			continue;
		}
		// 抽样依据「会话 DOI 总分降序」（tf-0159 §2.3）：分数要真算，不能拿 handle 数反推。
		const score = sessionFileScores(events, writer.id).reduce(
			(sum, row) => sum + row.doi,
			0,
		);
		candidates.push({ writer: ref, handles, score });
	}
	candidates.sort(
		(a, b) => b.score - a.score || a.writer.id.localeCompare(b.writer.id),
	);
	const sampled = allSessions
		? candidates
		: candidates.slice(0, Math.max(0, sampleN));

	const rows: QueueRow[] = [];
	let total = 0;
	let reviewed = 0;
	let endorsed = 0;
	for (const candidate of sampled) {
		const own = humanReviews.filter(
			(review) => review.writer === candidate.writer.id,
		);
		const judgement = landmarkReviewJudgement(
			candidate.handles.map((handle) => ({ handle })),
			own,
		);
		total += judgement.total;
		reviewed += judgement.reviewed;
		endorsed += judgement.endorsed;
		const interest = interestFromEvents(
			events,
			candidate.writer.id,
			Date.now(),
			{
				clock: "session",
			},
		);
		for (const handle of candidate.handles) {
			rows.push({
				writer: candidate.writer.id,
				handle,
				summary: summaryFor(interest, handle),
				current: latest.get(pairKey(candidate.writer.id, handle)) ?? null,
			});
		}
	}

	const inSet = new Set<string>();
	for (const candidate of candidates)
		for (const handle of candidate.handles)
			inSet.add(pairKey(candidate.writer.id, handle));
	let legacyHuman = 0;
	let legacySteward = 0;
	let inSetHuman = 0;
	let inSetSteward = 0;
	for (const review of humanReviews) {
		if (inSet.has(pairKey(review.writer, review.handle))) inSetHuman += 1;
		else legacyHuman += 1;
	}
	for (const review of stewardReviews) {
		if (inSet.has(pairKey(review.writer, review.handle))) inSetSteward += 1;
		else legacySteward += 1;
	}

	return {
		bb,
		candidateSessions: candidates.length,
		directoryOnlyWriters,
		gatedWriters,
		judgement: {
			total,
			reviewed,
			endorsed,
			rejected: reviewed - endorsed,
			endorsedShare: total > 0 ? endorsed / total : null,
			reviewedCoverage: total > 0 ? reviewed / total : null,
		},
		legacy: {
			human: legacyHuman,
			steward: legacySteward,
			inSetHuman,
			inSetSteward,
		},
		pending: rows.filter((row) => row.current === null).length,
		rows: rows.sort(
			(a, b) =>
				Number(a.current !== null) - Number(b.current !== null) ||
				a.writer.localeCompare(b.writer) ||
				a.handle.localeCompare(b.handle),
		),
		sampledSessions: sampled.length,
		starvedWriters,
		thresholdFileLandmarks,
		writerRefs: writers.map((writer) => ({
			id: writer.id,
			kind: writer.kind,
		})),
		writersTotal: writers.length,
	};
}

const report = await buildQueue();
const { bb, rows, judgement } = report;
const scopeLabel = allSessions
	? `全量（--all-sessions）`
	: `抽样 sampledSessions: ${report.sampledSessions}/${report.candidateSessions}`;
const cn = (value: number | null): string => value?.toFixed(4) ?? "无样本";

const applyPath = at("--apply");
if (applyPath) {
	// 来源决定这条结论算进哪条读数：默认 human（用户认可口径）；加 --steward
	// 则是代理自审——真实数据，但不构成用户认可，也就抬不高 human 口径。
	const applySource: LandmarkReviewSource = has("--steward")
		? "steward"
		: "human";
	const answers = JSON.parse(
		await readFile(resolve(applyPath), "utf8"),
	) as Array<{
		writer: string;
		handle: string;
		verdict: "endorse" | "reject" | null;
		reason?: string;
	}>;
	let applied = 0;
	const skipped: string[] = [];
	for (const answer of answers) {
		if (answer.verdict !== "endorse" && answer.verdict !== "reject") continue;
		try {
			await reviewLandmark(
				bb,
				answer.writer,
				answer.handle,
				answer.verdict,
				answer.reason,
				{ source: applySource },
			);
			applied += 1;
		} catch (error) {
			skipped.push(`${answer.writer}/${answer.handle}: ${String(error)}`);
		}
	}
	console.log(
		`已回填地标复核 ${applied} 条（来源 ${applySource}）；跳过 ${skipped.length} 条`,
	);
	for (const line of skipped.slice(0, 10)) console.log(`  跳过：${line}`);
	const after = await buildQueue();
	console.log(
		`本次问到的部分（口径 ${denominator} · ${scopeLabel}）：认可 ${after.judgement.endorsed} / 全部候选 ${after.judgement.total} = ${cn(after.judgement.endorsedShare)}（复核覆盖 ${cn(after.judgement.reviewedCoverage)}）`,
	);
	// 全站读数与「本次问到的部分」必须分开报：只答了抽样的 5 个会话时，两者的分母
	// 差着十几倍，并排放才不会被当成指标涨跌。L1 的判据读数取**全站**（账本 TF-0154
	// 读的也是全站），所以下面这条才是能不能收口 TF-0057 的那一个数。
	// 全站读数跟**出题口径**走（含 requireEdits）：人答的是哪个集合，读数就算哪个集合。
	const allEvents = await bb.events.all();
	const now = Date.now();
	const siteWide = currentLandmarkAcceptance(
		allEvents,
		after.writerRefs,
		now,
		applySource,
		{ denominator: "session-top-k", requireEdits },
	);
	console.log(
		`全站读数（口径 ${siteWide.denominator} · requireEdits ${siteWide.requireEdits} · 全部 ${after.candidateSessions} 个候选会话）：认可 ${siteWide.endorsed} / 全部候选 ${siteWide.total} = ${cn(siteWide.endorsedShare)}（复核覆盖 ${cn(siteWide.reviewedCoverage)}；未复核 ${siteWide.total - siteWide.reviewed} 条）`,
	);
	// 双读数并报一个周期：口径换了读数会跳，两条并排才归因得到口径而不是产品。
	const threshold = currentLandmarkAcceptance(
		allEvents,
		after.writerRefs,
		now,
		applySource,
	);
	console.log(
		`阈值口径读数（历史可比 · 全站）：认可 ${threshold.endorsed} / 全部 ${threshold.total} = ${cn(threshold.endorsedShare)}${threshold.total === 0 ? "（空集 → 不可计算，正是切口径的依据）" : ""}`,
	);
	// 「未过滤」对照（翻默认前的旧定义）：与主读数的差距即被过滤的纯浏览噪声。
	const counterpart = currentLandmarkAcceptance(
		allEvents,
		after.writerRefs,
		now,
		applySource,
		{ denominator: "session-top-k", requireEdits: !requireEdits },
	);
	console.log(
		`未过滤对照（requireEdits: ${!requireEdits} · 全站）：认可 ${counterpart.endorsed} / 全部候选 ${counterpart.total} = ${cn(counterpart.endorsedShare)}${requireEdits ? "（主读数已含过滤，2026-09-11 翻默认）" : ""}`,
	);
	// 自审口径单独报一行：它是真实数据，但和「用户认可」不是同一件事，绝不并列成一个数
	if (applySource === "steward") {
		const human = currentLandmarkAcceptance(
			allEvents,
			after.writerRefs,
			Date.now(),
			"human",
			{ denominator: "session-top-k" },
		);
		console.log(
			`用户认可口径（human · 新口径）：认可 ${human.endorsed} / 全部候选 ${human.total} = ${cn(human.endorsedShare)}`,
		);
		console.log(
			"自审只说明「机制能在无真人的前提下跑通」；用户认可那一格仍然等人本人回答，不会被自审抬起。",
		);
	}
	if (siteWide.endorsedShare !== null)
		console.log(
			siteWide.endorsedShare >= 0.8
				? "L1 判据（≥ 0.8 · 全站）已满足，可据此收口 TF-0057 的地标验收。"
				: `L1 判据（≥ 0.8 · 全站）未满足：当前 ${cn(siteWide.endorsedShare)}。若未复核的 ${siteWide.total - siteWide.reviewed} 条里还有没问到的（抽样只覆盖了 ${after.sampledSessions} 个会话），那部分是缺样本而不是候选选错；改善候选本身的路径是种类门 / 文件级 / 相对选择，不是回头调阈值或加权。`,
		);
} else if (at("--template")) {
	// verdict 刻意留空：模板若自带现状，照着点一遍就是一次静默的重新认可，而脚本手势
	// 产生的结论本来就不构成用户认可——必须由人重新回答。（回填只认 verdict，
	// 留空的那条会被拒并点名，不会被悄悄当成认可。）
	//
	// 但「哪条已经答过」得让人看得见：不知道现状，人要么把已认可的那条再点一遍，
	// 要么漏掉真正待办的那条。所以 `current` 只作展示、回填时忽略。
	// 只答待办那几条：加 `--pending-only`。
	const source = has("--pending-only")
		? rows.filter((row) => row.current === null)
		: rows;
	const template = source.map((row) => ({
		writer: row.writer,
		handle: row.handle,
		current: row.current,
		verdict: null,
		reason: "",
	}));
	await writeFile(
		resolve(at("--template") as string),
		`${JSON.stringify(template, null, 1)}\n`,
	);
	console.log(`已写出待填模板：${resolve(at("--template") as string)}`);
	console.log("把 verdict 改成 endorse / reject 后，用 --apply 回填。");
} else {
	const out = at("--out");
	const pendingRows = rows.filter((row) => row.current === null);
	const shown = has("--pending-only") ? pendingRows : rows;
	const lines: string[] = [];
	lines.push("# L1 地标复核队列（TF-0057 验收三的数据源）");
	lines.push("");
	lines.push(
		`- 黑板：\`${bb.paths.root}\` · 写者 ${report.writersTotal} 个（种类门排除 git/human ${report.gatedWriters} 个）`,
	);
	lines.push(
		`- 分母口径：\`${denominator}\`${denominator === "session-top-k" ? `（每会话文件级 top-${topK}）` : "（DOI>10 的文件级集合）"} · 候选过滤 \`requireEdits: ${requireEdits}\`${requireEdits ? "（只认可落笔 + 只读会话豁免，2026-09-11 翻默认）" : "（--unfiltered 回滚对照）"} · 范围 ${scopeLabel}`,
	);
	lines.push(
		`- 当前读数（只含本次范围内的 ${report.sampledSessions} 个会话）：认可 ${judgement.endorsed} / 全部候选 ${judgement.total} = ${cn(judgement.endorsedShare)}；复核覆盖 ${cn(judgement.reviewedCoverage)}`,
	);
	lines.push(
		`- 待复核 ${pendingRows.length} 条（下表 ${shown.length} 条）。判据：地标集合中 ≥ 80% 是用户认可的「这次干的活的核心」。`,
	);
	lines.push(
		`- 结论连续性：已有复核 ${report.legacy.inSetHuman + report.legacy.human + report.legacy.inSetSteward + report.legacy.steward} 条（human ${report.legacy.inSetHuman + report.legacy.human} · steward ${report.legacy.inSetSteward + report.legacy.steward}）→ 落在新集合 ${report.legacy.inSetHuman + report.legacy.inSetSteward} 条 · 变 legacy ${report.legacy.human + report.legacy.steward} 条。legacy 只计数：**不删除、不改判**，它仍然是当时的真实回答。`,
	);
	if (report.thresholdFileLandmarks > 0 || denominator === "session-top-k")
		lines.push(
			`- 标定信号：门后**阈值口径**下文件级地标 ${report.thresholdFileLandmarks} 条（本轮四现场均为 0——绝对阈值对分散触碰结构性不适用，这就是切分母的依据，此栏长期保留）；另有 ${report.starvedWriters} 个写者排不出任何文件级候选，其中 ${report.directoryOnlyWriters} 个只碰过目录。`,
		);
	if (!allSessions && report.sampledSessions < report.candidateSessions)
		lines.push(
			`- ⚠️ 本读数**只覆盖抽样的 ${report.sampledSessions} 个会话**，其余 ${report.candidateSessions - report.sampledSessions} 个候选会话未抽样、不计入本次读数。要全量读数用 \`--all-sessions\`（人评不了，只用于核对）。`,
		);
	lines.push("");
	lines.push(
		"这一项只能由人回答：脚本与模型安排的手势会把读数收敛到脚本常数，不构成用户认可。下表里已有的结论如果来自脚本，" +
			"只有人自己再答一次才会被覆盖（同一地标取最新结论）。",
	);
	lines.push("");
	lines.push("| 写者 | 地标 | 摘要 | 现状 |");
	lines.push("| --- | --- | --- | --- |");
	for (const row of shown.slice(0, 200))
		lines.push(
			`| \`${row.writer}\` | \`${row.handle}\` | ${row.summary.replace(/\|/g, "/")} | ${row.current ?? "未复核"} |`,
		);
	lines.push("");
	lines.push("回填方式（任选）：");
	lines.push("");
	lines.push("```bash");
	lines.push("# 逐条（CLI 同支手势，human 来源，只对候选集合有效）");
	lines.push(
		"bun packages/workbench/src/index.ts context review <handle> --writer <id> --endorse",
	);
	lines.push("");
	lines.push("# 或整批：生成模板 → 填 verdict → 回填");
	lines.push(
		"bun packages/workbench/scripts/e2e/landmark-review-queue.ts --template answers.json",
	);
	lines.push(
		"bun packages/workbench/scripts/e2e/landmark-review-queue.ts --apply answers.json",
	);
	lines.push("```");
	lines.push("");
	const text = `${lines.join("\n")}\n`;
	if (out) {
		await writeFile(resolve(out), text, "utf8");
		console.log(`wrote ${resolve(out)}`);
	} else {
		process.stdout.write(text);
	}
	console.log(
		`[landmark-queue] 口径 ${denominator} · requireEdits ${requireEdits} · 范围 ${scopeLabel} · 候选 ${judgement.total} 条，待复核 ${pendingRows.length} 条，无文件候选写者 ${report.starvedWriters} 个，当前认可率 ${cn(judgement.endorsedShare)}`,
	);
}
