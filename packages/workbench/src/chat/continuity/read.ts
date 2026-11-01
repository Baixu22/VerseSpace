import type { Blackboard } from "../../blackboard";
import { pendingPremiseNotices } from "../../runtime/delivery";
import type { WorkbenchEvent } from "../../types/event";
import { ThreadRepository } from "../thread-repository";
import type { StoredMessage, ThreadMeta } from "../thread-types";
import { deriveSessionContinuity, summarizeContinuity } from "./derive";
import type { SessionContinuity } from "./types";

/**
 * 会话延续性的读取面。
 *
 * 会话的「生命」被拆在三个已有的写者里：线程 meta（身份与运行状态）、
 * messages.jsonl（说过什么）、事件日志（离开、恢复、中断、通知投递）。
 * 这里把三处折成一份读数，**不新增存储**——账本已经记下的事实，不应该
 * 为了展示再复制一份真相（ADR-0010：一条日志、两类事实、三个投影）。
 */

function providerSessionOf(meta: ThreadMeta): {
	lane: string | null;
	providerSessionId: string | null;
	resumable: boolean;
} {
	const lane = meta.lastRun?.provider ?? meta.binding?.provider ?? null;
	if (lane === "codex") {
		return {
			lane,
			providerSessionId: meta.codexSessionId ?? null,
			resumable: Boolean(meta.codexSessionId),
		};
	}
	if (lane === "claude") {
		return {
			lane,
			providerSessionId: meta.claudeSessionId ?? null,
			resumable: Boolean(meta.hasResumableSession),
		};
	}
	return { lane, providerSessionId: null, resumable: false };
}

function messageFacts(messages: StoredMessage[]) {
	const last = messages.at(-1);
	return {
		total: messages.length,
		assistant: messages.filter((message) => message.role === "assistant")
			.length,
		lastAt: last?.at ?? null,
		lastRole: last?.role ?? null,
	};
}

function payloadOf(event: WorkbenchEvent): Record<string, unknown> {
	return event.payload &&
		typeof event.payload === "object" &&
		!Array.isArray(event.payload)
		? (event.payload as Record<string, unknown>)
		: {};
}

function messageCountOf(payload: Record<string, unknown>): number | null {
	const raw = payload.atMessageCount;
	return typeof raw === "number" && Number.isSafeInteger(raw) ? raw : null;
}

/**
 * 装配一份读数的输入事实：把两件事分开收集，不混成一种。
 *
 * - `interruptions`（`thread.turn_interrupted`）：宿主清扫在 `status` 仍停
 *   `running` 时落下的观察——「这一轮没被收尾就消失了」，原因由生产者写入。
 * - `cancellations`（`thread.turn_cancelled`）：用户主动按停（TF-0330）。
 *   它带自己的 `atMessageCount` 与事件 id，用来回答「这条中断是不是其实
 *   是被主动停的」。
 */
function continuityObservationsOf(
	events: readonly WorkbenchEvent[],
	threadId: string,
	messages: StoredMessage[],
) {
	const mine = events.filter((event) => payloadOf(event).threadId === threadId);
	const cancellations = mine
		.filter((event) => event.type === "thread.turn_cancelled")
		.map((event) => ({
			at: event.timestamp,
			eventId: event.id ?? null,
			messageCount: messageCountOf(payloadOf(event)),
		}));
	const interruptions = mine
		.filter((event) => event.type === "thread.turn_interrupted")
		.map((event) => {
			const payload = payloadOf(event);
			const messageCount = messageCountOf(payload);
			// 中断之后有没有人替这轮说过话：消息条数是最准的切点，缺它时退回
			// 时间比较（旧记录没有条数，仍然可以回答「之后有没有助手消息」）。
			const after =
				messageCount === null
					? messages.filter(
							(message) =>
								Date.parse(message.at) >= Date.parse(event.timestamp),
						)
					: messages.slice(messageCount);
			// 用户主动停在这次中断之后 = 这一轮其实是被人停的，不是被切断。
			// 判定只用事件的事实（时间戳），不推断因果。
			const userStopped = cancellations.some(
				(cancel) => Date.parse(cancel.at) >= Date.parse(event.timestamp),
			);
			return {
				at: event.timestamp,
				eventId: event.id ?? null,
				messageCount,
				reason:
					typeof payload.reason === "string" && payload.reason
						? payload.reason
						: "unknown",
				recovered: after.some((message) => message.role === "assistant"),
				userStopped,
			};
		});
	return { interruptions, cancellations };
}

async function safeMessages(
	store: ThreadRepository,
	threadId: string,
): Promise<StoredMessage[]> {
	try {
		return await store.messages(threadId);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

/**
 * 一个线程的延续性读数。线程不存在时抛出，调用方决定怎么报告。
 *
 * 调用方已经持有 `events` 与 `pending` 时传进来（`RestoreView` 与聊天 GET 都要
 * 读同一份事件日志）——否则一次 GET 会把账本读两遍，且两份读法出现分叉时
 * 卡片与读数会互相矛盾。
 */
export async function readSessionContinuity(
	bb: Blackboard,
	threadId: string,
	now: Date = new Date(),
	preloaded?: {
		events?: readonly WorkbenchEvent[];
		pending?: Awaited<ReturnType<typeof pendingPremiseNotices>>;
	},
): Promise<SessionContinuity> {
	const store = new ThreadRepository(bb);
	const meta = await store.get(threadId).catch((error: unknown) => {
		// 一条不存在的线程与一条读不出来的线程是两件事：前者是调用者给错了
		// id，该直接告诉它；后者是数据损坏，不该被读成「没有这条会话」。
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`线程不存在：${threadId}`);
		}
		throw error;
	});
	const messages = await safeMessages(store, threadId);
	const [events, pending] = await Promise.all([
		preloaded?.events ?? bb.events.all(),
		preloaded?.pending ?? pendingPremiseNotices(bb),
	]);
	const notice = pending.find((entry) => entry.writerId === threadId);
	const deliveredNotices = events.filter(
		(event) =>
			event.type === "premise_notice_delivered" &&
			payloadOf(event).writer === threadId,
	).length;
	const provider = providerSessionOf(meta);
	const observations = continuityObservationsOf(events, threadId, messages);
	return deriveSessionContinuity({
		threadId,
		title: meta.title,
		archived: Boolean(meta.archived),
		createdAt: meta.createdAt,
		lane: provider.lane,
		providerSessionId: provider.providerSessionId,
		resumable: provider.resumable,
		lineage: {
			forkedFrom: meta.forkOf?.sourceThreadId ?? null,
			promotedAs: meta.promotion?.title ?? null,
			adoptedSnapshot: meta.adoptSnapshot?.id ?? null,
		},
		status: meta.status,
		messages: messageFacts(messages),
		interruptions: observations.interruptions,
		cancellations: observations.cancellations,
		pendingNotices: notice ? 1 : 0,
		pendingPaths: notice
			? [...new Set(notice.claims.map((claim) => claim.path))].sort()
			: [],
		deliveredNotices,
		now: now.toISOString(),
	});
}

/** 所有线程的读数，附一份只数事实的汇总。线程列表读不出来时抛错，不返回空列表。 */
export async function readAllSessionContinuity(
	bb: Blackboard,
	now: Date = new Date(),
): Promise<{
	rows: SessionContinuity[];
	summary: ReturnType<typeof summarizeContinuity>;
}> {
	const store = new ThreadRepository(bb);
	const threads = await store.list();
	const [events, pending] = await Promise.all([
		bb.events.all(),
		pendingPremiseNotices(bb),
	]);
	const rows: SessionContinuity[] = [];
	for (const meta of threads) {
		const messages = await safeMessages(store, meta.id);
		const notice = pending.find((entry) => entry.writerId === meta.id);
		const deliveredNotices = events.filter(
			(event) =>
				event.type === "premise_notice_delivered" &&
				payloadOf(event).writer === meta.id,
		).length;
		const provider = providerSessionOf(meta);
		const observations = continuityObservationsOf(events, meta.id, messages);
		rows.push(
			deriveSessionContinuity({
				threadId: meta.id,
				title: meta.title,
				archived: Boolean(meta.archived),
				createdAt: meta.createdAt,
				lane: provider.lane,
				providerSessionId: provider.providerSessionId,
				resumable: provider.resumable,
				lineage: {
					forkedFrom: meta.forkOf?.sourceThreadId ?? null,
					promotedAs: meta.promotion?.title ?? null,
					adoptedSnapshot: meta.adoptSnapshot?.id ?? null,
				},
				status: meta.status,
				messages: messageFacts(messages),
				interruptions: observations.interruptions,
				cancellations: observations.cancellations,
				pendingNotices: notice ? 1 : 0,
				pendingPaths: notice
					? [...new Set(notice.claims.map((claim) => claim.path))].sort()
					: [],
				deliveredNotices,
				now: now.toISOString(),
			}),
		);
	}
	return { rows, summary: summarizeContinuity(rows) };
}
