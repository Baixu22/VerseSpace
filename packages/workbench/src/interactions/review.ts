import type { Blackboard } from "../blackboard";
import type { WorkbenchEvent } from "../types/event";
import { interestFromEvents } from "./context";
import { isRecordingWriter, landmarkCandidates } from "./landmark-set";
import { INTERACTIONS_SOURCE, INTERACTIONS_TYPE } from "./types";

export const LANDMARK_REVIEW_TYPE = "landmark.reviewed" as const;

export type LandmarkVerdict = "endorse" | "reject";

/**
 * 复核来源。分两类，**读数必须分开算**：
 *
 * - `human`：用户本人回答的。L1 的「用户认可率」只认这一种。
 * - `steward`：代理自审（没有真人可问时由 agent 按证据回答）。它是**真实数据**
 *   但不是**用户认可**，所以既不冒充 human，也不能让 human 口径凭空变好——两
 *   条读数在账本里各占一行、各带来源标签。
 *
 * 这样做的意义：机制能在无人的前提下跑通并持续沉淀，同时「用户认可」那一格
 * 仍然诚实地空着（fit 停在 unknown），不会把自审洗成人类证据。
 */
export const LANDMARK_REVIEW_SOURCES = ["human", "steward"] as const;
export type LandmarkReviewSource = (typeof LANDMARK_REVIEW_SOURCES)[number];

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
	options: { source?: LandmarkReviewSource } = {},
): Promise<WorkbenchEvent> {
	const source = options.source ?? "human";
	if (!(LANDMARK_REVIEW_SOURCES as readonly string[]).includes(source)) {
		throw new Error(`未知的复核来源：${source}`);
	}
	if (verdict !== "endorse" && verdict !== "reject") {
		throw new Error("verdict 必须是 endorse 或 reject");
	}
	// 校验必须和**队列展示的同一份读数**对齐，否则人看到 N 条、却一条都回填不了。
	// 2026-09-11 彩排实测：这里原先用 `collectInterest`（默认「现在」时钟 + 投影表，
	// 含目录与回退项），而队列与 L1 的分母是「会话时钟下的文件级地标」——两段口径
	// 一分家，界面上三条待办全部被拒（"不在当前地标集合中"），复核通道整体失效。
	// 所以现在不在这里重写规则：候选集合统一由 `landmarkCandidates` 给，与本函数
	// 之外的所有读者共用一份实现。
	const session = await bb.sessions.get(writer);
	if (!session) throw new Error(`写者未注册：${writer}`);
	// 门在尺子前面：git 监视 / human 编辑器记录的是「文件被动过」，不是「这段会话
	// 干的是什么」，它们的条目本就不是 L1 候选，给它点赞只是把噪声洗成证据。
	if (isRecordingWriter(session))
		throw new Error(
			`记录型写者（${session.kind}）不进 L1 候选，不能复核：${writer}`,
		);
	const records = await bb.events.query({
		source: INTERACTIONS_SOURCE,
		type: INTERACTIONS_TYPE,
	});
	const now = Date.now();
	const reading = interestFromEvents(records, writer, now, {
		clock: "session",
	});
	// 接受集合 = 阈值口径候选 ∪ 相对口径候选 ∪ 投影表。
	// 前两条是双读数期的两把尺子（账本并报一个周期），两条都得能回填，否则切换
	// 口径的那一刻通道会断；投影表是「系统当下展示给人看的东西」，给没展示过的
	// 东西点赞是噪音而不是复核。三者的**参考时刻必须一致**（都走会话时钟）。
	const acceptable = new Set([
		...landmarkCandidates(records, writer, { now }),
		...landmarkCandidates(records, writer, {
			now,
			denominator: "session-top-k",
		}),
		...reading.landmarks.map((row) => row.handle),
	]);
	if (!acceptable.has(handle)) {
		throw new Error(`不在当前地标集合中：${handle}`);
	}
	const trimmed = reason?.trim();
	return bb.events.append({
		timestamp: new Date().toISOString(),
		source,
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

/**
 * 折叠全部复核事件为行集：只认指定来源与合法 verdict，坏 payload 跳过。
 * 默认只收 `human`——L1 的「用户认可率」不能被自审或脚本手势抬高。
 */
export function collectLandmarkReviews(
	events: WorkbenchEvent[],
	source: LandmarkReviewSource = "human",
): LandmarkReview[] {
	const rows: LandmarkReview[] = [];
	for (const event of events) {
		if (event.type !== LANDMARK_REVIEW_TYPE || event.source !== source) {
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
