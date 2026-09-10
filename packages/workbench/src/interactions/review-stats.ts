import type { WorkbenchEvent } from "../types/event";
import { interestFromEvents, sessionFileTopK } from "./context";
import {
	collectLandmarkReviews,
	type LandmarkReview,
	landmarkReviewJudgement,
} from "./review";
import { INTERACTIONS_SOURCE, INTERACTIONS_TYPE } from "./types";

type Judgement = ReturnType<typeof landmarkReviewJudgement>;
export type LandmarkAcceptance = Judgement & {
	byWriter: Array<Judgement & { writer: string }>;
};

/**
 * 相对选择的可计量性（TF-0156 验收三）：分母 = 有文件级交互的会话；分子 = 该会话
 * 的文件级 top-K 非空的会话数。用绝对阈值时这个分子在四个现场里三个是 0，L1 就
 * 算不出来；相对选择的覆盖实测是 76% / 100% / 94% / 92%。
 *
 * 这条读数**不改** L1 现在的分母（`currentLandmarkAcceptance` 仍是阈值口径），
 * 是为了让「切换口径」这件事有数字支撑、且不搅动已经发出去的复核队列。
 */
export type RelativeLandmarkCoverage = {
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
};

export function relativeLandmarkCoverage(
	events: WorkbenchEvent[],
	writerIds: string[],
	k = 3,
	now = Date.now(),
): RelativeLandmarkCoverage {
	const records = new Map(
		writerIds.map((writer) => [writer, [] as WorkbenchEvent[]]),
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
	const handles = new Set<string>();
	for (const [writer, rows] of records) {
		const hasFile = rows.some(
			(event) =>
				(event.payload as { contentType?: string } | null)?.contentType ===
				"file",
		);
		if (!hasFile) continue;
		sessions += 1;
		const top = sessionFileTopK(rows, writer, k, now);
		if (top.length === 0) continue;
		withSet += 1;
		items += top.length;
		for (const handle of top) handles.add(handle);
	}
	return {
		k,
		sessions,
		withSet,
		items,
		share: sessions > 0 ? withSet / sessions : null,
		distinctHandles: handles.size,
	};
}

/** Each (writer, handle) is one current landmark; repeated reviews are corrections. */
export function currentLandmarkAcceptance(
	events: WorkbenchEvent[],
	writerIds: string[],
	now = Date.now(),
): LandmarkAcceptance {
	const records = new Map(
		writerIds.map((writer) => [writer, [] as WorkbenchEvent[]]),
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
	const reviews = new Map<string, LandmarkReview[]>();
	for (const review of collectLandmarkReviews(events)) {
		const bucket = reviews.get(review.writer) ?? [];
		bucket.push(review);
		reviews.set(review.writer, bucket);
	}
	// L1 的分母是「地标集合（DOI>10）」（positioning-v6 §11），不是投影列表：
	// 投影在没有真地标时会回退到可见集 top-N，那张表里的目录与项目根按
	// project.ts 自己的注释「不是地标」。用回退表当分母会让 L1 量到显示策略，
	// 而恰好是「这个写者没有地标」这件事被藏起来。
	//
	// 进一步收在文件级：目录能进 DOI 地标集合，却不能被回答成「这次干的活的
	// 核心」。2026-09-11 四个现场实测目录占比 33%–75%，且阈值越低占比越高。
	//
	// 参考时刻取**会话自己的时钟**：§11 问的是「一段会话结束后，系统能列出该
	// 会话的地标集合」，按「现在」算的话，同一段会话的地标会随日期流逝自己跌到
	// 线下（DOI 的减项就是 now − 事件时间），验收读数既不可复现，也会把几天前
	// 干过活的写者一律算成「没有地标」。
	const byWriter = [...records].map(([writer, rows]) => ({
		writer,
		...landmarkReviewJudgement(
			interestFromEvents(rows, writer, now, {
				clock: "session",
			}).fileLandmarkHandles.map((handle) => ({ handle })),
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
		endorsedShare: totals.total > 0 ? totals.endorsed / totals.total : null,
		reviewedCoverage: totals.total > 0 ? totals.reviewed / totals.total : null,
		byWriter,
	};
}
