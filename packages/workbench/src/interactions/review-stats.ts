import type { WorkbenchEvent } from "../types/event";
import { sessionFileTopK } from "./context";
import {
	DEFAULT_LANDMARK_TOP_K,
	DEFAULT_REQUIRE_EDITS,
	isRecordingWriter,
	type LandmarkCandidateOptions,
	type LandmarkDenominator,
	landmarkCandidates,
	type WriterRef,
} from "./landmark-set";
import {
	collectLandmarkReviews,
	type LandmarkReviewSource,
	landmarkReviewJudgement,
} from "./review";
import { INTERACTIONS_SOURCE, INTERACTIONS_TYPE } from "./types";

// 门与尺子的定义在 landmark-set.ts（复核手势要用同一份，不能有环），此处转出去
// 让既有调用点继续从 review-stats 取——两个入口，一份实现。
export {
	DEFAULT_LANDMARK_TOP_K,
	DEFAULT_REQUIRE_EDITS,
	isRecordingWriter,
	type LandmarkCandidateOptions,
	type LandmarkDenominator,
	landmarkCandidates,
	RECORDING_WRITER_KINDS,
	type WriterRef,
} from "./landmark-set";

type Judgement = ReturnType<typeof landmarkReviewJudgement>;

/**
 * 相对选择的可计量性（TF-0156 验收三）：分母 = 有文件级交互的会话；分子 = 该会话
 * 的文件级 top-K 非空的会话数。用绝对阈值时这个分子在四个现场里三个是 0，L1 就
 * 算不出来；相对选择的覆盖实测是 76% / 100% / 94% / 92%，门后是 83/83、30/30、
 * 13/13、10/10（100%）——相对口径只在「一个文件都没碰」时才空。
 */
export type RelativeLandmarkCoverage = {
	denominator: LandmarkDenominator;
	k: number;
	/** 有文件级触碰的会话数。 */
	sessions: number;
	/** top-K 非空的会话数（只在「一个文件都没碰」时为空）。 */
	withSet: number;
	/** 全部条目数。 */
	items: number;
	/** withSet / sessions，没有会话时为 null。 */
	share: number | null;
	/** 去重后的文件 handle 数。 */
	distinctHandles: number;
	/** 被种类门排除的写者数（git/human），它们不进上面的任何一个数。 */
	gatedWriters: number;
};

export function relativeLandmarkCoverage(
	events: WorkbenchEvent[],
	writers: WriterRef[],
	k = DEFAULT_LANDMARK_TOP_K,
	now = Date.now(),
): RelativeLandmarkCoverage {
	const records = new Map(
		writers.map((writer) => [writer.id, [] as WorkbenchEvent[]]),
	);
	for (const event of events) {
		if (
			event.source !== INTERACTIONS_SOURCE ||
			event.type !== INTERACTIONS_TYPE
		)
			continue;
		const writer = (event.payload as { origin?: string } | null)?.origin;
		if (writer) records.get(writer)?.push(event);
	}
	let sessions = 0;
	let withSet = 0;
	let items = 0;
	let gatedWriters = 0;
	const handles = new Set<string>();
	for (const writer of writers) {
		if (isRecordingWriter(writer)) {
			gatedWriters += 1;
			continue;
		}
		const top = sessionFileTopK(
			records.get(writer.id) ?? [],
			writer.id,
			k,
			now,
		);
		if (top.length === 0) continue;
		// 有文件级 top-K ⟺ 至少有文件级触碰（只碰过目录的写者排不出文件级 top-K），
		// 所以两条计数在实现上恒等。分开保留是因为它们回答两个问题：分母多大、
		// 分子多大。只有覆盖 100% 才说明「相对口径不制造空集」。
		sessions += 1;
		withSet += 1;
		items += top.length;
		for (const handle of top) handles.add(handle);
	}
	return {
		denominator: "session-top-k",
		k,
		sessions,
		withSet,
		items,
		share: sessions > 0 ? withSet / sessions : null,
		distinctHandles: handles.size,
		gatedWriters,
	};
}

export type LandmarkAcceptance = Judgement & {
	/** 这份读数是哪把尺子量出来的：读数自带口径，两次快照才归因得到变化。 */
	denominator: LandmarkDenominator;
	topK: number;
	/** 是否只认可有落笔（edit）的候选：读数自带，口径变了数字会跳，必须能归因。 */
	requireEdits: boolean;
	/** 被种类门排除的写者数（git/human）：既不进分母也不进分子。 */
	gatedWriters: number;
	/**
	 * 复核结论落在当前集合之外的**条数**（legacy）：保留、不改判，只计数。
	 * 口径切换时数字会跳，这一栏是把「跳」解释成口径而不是产品的那一半证据。
	 */
	legacyReviews: number;
	byWriter: Array<Judgement & { writer: string }>;
};

const pairKey = (writer: string, handle: string): string =>
	`${writer}\u0000${handle}`;

/**
 * L1 读数。分母按 `denominator` 取（**默认阈值口径**，历史可比），并叠加种类门。
 *
 * 为什么门和尺子要在一起：门清掉 git/human 的「文件被动过」噪声，尺子决定 agent
 * 会话里哪些文件算「这次干活的核心」。顺序纪律是**先门后尺**——反了就是拿新尺子
 * 量同一批错东西（B 实验已踩过一次）。
 *
 * 分母不变的两条老规矩照旧：单位是文件级（目录不进分母），参考时刻是会话自己的
 * 时钟。细节理由见 landmark-set.ts。
 */
export function currentLandmarkAcceptance(
	events: WorkbenchEvent[],
	writers: WriterRef[],
	now = Date.now(),
	source: LandmarkReviewSource = "human",
	options: LandmarkCandidateOptions = {},
): LandmarkAcceptance {
	const denominator = options.denominator ?? "threshold";
	const topK = options.topK ?? DEFAULT_LANDMARK_TOP_K;
	const requireEdits = options.requireEdits ?? DEFAULT_REQUIRE_EDITS;
	// 只认「有过交互事件的写者」：注册了但一条都没动过的写者不该出现在 byWriter 里，
	// 否则「这个写者没有地标」会被记成一条 0 分母的行，与「根本没人干活」混在一起。
	const active = new Set<string>();
	for (const event of events) {
		if (
			event.source !== INTERACTIONS_SOURCE ||
			event.type !== INTERACTIONS_TYPE
		)
			continue;
		const writer = (event.payload as { origin?: string } | null)?.origin;
		if (writer) active.add(writer);
	}
	const reviews = new Map<string, ReturnType<typeof collectLandmarkReviews>>();
	for (const review of collectLandmarkReviews(events, source)) {
		const bucket = reviews.get(review.writer) ?? [];
		bucket.push(review);
		reviews.set(review.writer, bucket);
	}
	let gatedWriters = 0;
	const candidatesByWriter = new Map<string, string[]>();
	for (const writer of writers) {
		if (isRecordingWriter(writer)) {
			gatedWriters += 1;
			continue;
		}
		if (!active.has(writer.id)) continue;
		candidatesByWriter.set(
			writer.id,
			landmarkCandidates(events, writer.id, {
				denominator,
				topK,
				now,
				requireEdits,
			}),
		);
	}
	const inSet = new Set<string>();
	for (const [writer, handles] of candidatesByWriter)
		for (const handle of handles) inSet.add(pairKey(writer, handle));
	// legacy：有结论、但落在当前集合之外的条数。含被门关掉的写者的全部结论——
	// 门不是判决，它只是换了分母；旧结论仍然可查、仍然是当时的真实回答。
	let legacyReviews = 0;
	for (const [writer, own] of reviews)
		for (const review of own)
			if (!inSet.has(pairKey(writer, review.handle))) legacyReviews += 1;
	const byWriter = [...candidatesByWriter].map(([writer, handles]) => ({
		writer,
		...landmarkReviewJudgement(
			handles.map((handle) => ({ handle })),
			reviews.get(writer) ?? [],
		),
	}));
	const totals = byWriter.reduce(
		(sum, row) => ({
			total: sum.total + row.total,
			reviewed: sum.reviewed + row.reviewed,
			endorsed: sum.endorsed + row.endorsed,
			rejected: sum.rejected + row.rejected,
		}),
		{ total: 0, reviewed: 0, endorsed: 0, rejected: 0 },
	);
	return {
		...totals,
		denominator,
		topK,
		requireEdits,
		gatedWriters,
		legacyReviews,
		endorsedShare: totals.total > 0 ? totals.endorsed / totals.total : null,
		reviewedCoverage: totals.total > 0 ? totals.reviewed / totals.total : null,
		byWriter,
	};
}
