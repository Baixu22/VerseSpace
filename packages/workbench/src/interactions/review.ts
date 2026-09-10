import type { Blackboard } from "../blackboard";
import type { WorkbenchEvent } from "../types/event";
import { collectInterest } from "./context";

export const LANDMARK_REVIEW_TYPE = "landmark.reviewed" as const;

export type LandmarkVerdict = "endorse" | "reject";

export interface LandmarkReview {
	reviewEventId: string;
	writer: string;
	handle: string;
	verdict: LandmarkVerdict;
	reason: string | null;
	at: string;
}

/**
 * L1 验收（TF-0057）的数据源：「地标集合中 80% 以上是用户认可的『这次干的
 * 活的核心』」。在此之前这条验收只能等——没有任何事件通道能把人的认可
 * 记下来。手势只对当前投影里的条目有效：给系统没展示的东西点赞，不是
 * 对投影的复核，是噪音。
 */
export async function reviewLandmark(
	bb: Blackboard,
	writer: string,
	handle: string,
	verdict: LandmarkVerdict,
	reason?: string,
): Promise<WorkbenchEvent> {
	if (verdict !== "endorse" && verdict !== "reject") {
		throw new Error("verdict 必须是 endorse 或 reject");
	}
	const landmarks = (await collectInterest(bb, writer)).landmarks;
	if (!landmarks.some((landmark) => landmark.handle === handle)) {
		throw new Error(`不在当前地标集合中：${handle}`);
	}
	const trimmed = reason?.trim();
	return bb.events.append({
		timestamp: new Date().toISOString(),
		source: "human",
		type: LANDMARK_REVIEW_TYPE,
		payload: {
			writer,
			handle,
			verdict,
			...(trimmed ? { reason: trimmed } : {}),
		},
	});
}

function payloadOf(event: WorkbenchEvent): Partial<LandmarkReview> | null {
	return event.payload && typeof event.payload === "object"
		? (event.payload as Partial<LandmarkReview>)
		: null;
}

/** 折叠全部复核事件为行集：只认 human 来源与合法 verdict，坏 payload 跳过。 */
export function collectLandmarkReviews(
	events: WorkbenchEvent[],
): LandmarkReview[] {
	const rows: LandmarkReview[] = [];
	for (const event of events) {
		if (event.type !== LANDMARK_REVIEW_TYPE || event.source !== "human") {
			continue;
		}
		if (!event.id) {
			continue;
		}
		const payload = payloadOf(event);
		if (
			!payload ||
			typeof payload.handle !== "string" ||
			typeof payload.writer !== "string" ||
			(payload.verdict !== "endorse" && payload.verdict !== "reject")
		) {
			continue;
		}
		rows.push({
			reviewEventId: event.id,
			writer: payload.writer,
			handle: payload.handle,
			verdict: payload.verdict,
			reason: typeof payload.reason === "string" ? payload.reason : null,
			at: event.timestamp,
		});
	}
	return rows;
}

/** 折叠全部复核事件：只认 human 来源与合法 verdict，坏 payload 跳过。 */
export function foldLandmarkReviews(events: WorkbenchEvent[]): {
	endorsed: number;
	rejected: number;
	lastAt: string | null;
} {
	let endorsed = 0;
	let rejected = 0;
	let lastAt: string | null = null;
	for (const review of collectLandmarkReviews(events)) {
		if (review.verdict === "endorse") endorsed += 1;
		else rejected += 1;
		lastAt = review.at;
	}
	return { endorsed, rejected, lastAt };
}

/**
 * L1 读数：每个地标取最新一次复核结论（修正以新事件追加），分母是整个
 * 当前地标集合——只复核两条就说 80% 是在骗自己，所以 coverage 单列。
 */
export function landmarkReviewJudgement(
	landmarks: Array<{ handle: string }>,
	reviews: LandmarkReview[],
): {
	total: number;
	reviewed: number;
	endorsed: number;
	rejected: number;
	endorsedShare: number | null;
	reviewedCoverage: number | null;
} {
	const latest = new Map<string, LandmarkReview>();
	for (const review of reviews) {
		latest.set(review.handle, review);
	}
	const landmarkHandles = new Set(landmarks.map((landmark) => landmark.handle));
	const reviewedHandles = [...latest.keys()].filter((handle) =>
		landmarkHandles.has(handle),
	);
	const endorsed = reviewedHandles.filter(
		(handle) => latest.get(handle)!.verdict === "endorse",
	).length;
	const total = landmarkHandles.size;
	return {
		total,
		reviewed: reviewedHandles.length,
		endorsed,
		rejected: reviewedHandles.length - endorsed,
		endorsedShare: total > 0 ? endorsed / total : null,
		reviewedCoverage: total > 0 ? reviewedHandles.length / total : null,
	};
}
