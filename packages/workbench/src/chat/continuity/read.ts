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

function interruptionsOf(
	events: readonly WorkbenchEvent[],
	threadId: string,
	messages: StoredMessage[],
) {
	return events
		.filter(
			(event) =>
				event.type === "thread.turn_interrupted" &&
				payloadOf(event).threadId === threadId,
		)
		.map((event) => {
			const payload = payloadOf(event);
			const rawCount = payload.atMessageCount;
			const messageCount =
				typeof rawCount === "number" && Number.isSafeInteger(rawCount)
					? rawCount
					: null;
			// 中断之后有没有人替这轮说过话：消息条数是最准的切点，缺它时退回
			// 时间比较（旧记录没有条数，仍然可以回答「之后有没有助手消息」）。
			const after =
				messageCount === null
					? messages.filter(
							(message) =>
								Date.parse(message.at) >= Date.parse(event.timestamp),
						)
					: messages.slice(messageCount);
			return {
				at: event.timestamp,
				eventId: event.id ?? null,
				messageCount,
				reason:
					typeof payload.reason === "string" && payload.reason
						? payload.reason
						: "unknown",
				recovered: after.some((message) => message.role === "assistant"),
			};
		});
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

/** 一个线程的延续性读数。线程不存在时抛出，调用方决定怎么报告。 */
export async function readSessionContinuity(
	bb: Blackboard,
	threadId: string,
	now: Date = new Date(),
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
		bb.events.all(),
		pendingPremiseNotices(bb),
	]);
	const notice = pending.find((entry) => entry.writerId === threadId);
	const deliveredNotices = events.filter(
		(event) =>
			event.type === "premise_notice_delivered" &&
			payloadOf(event).writer === threadId,
	).length;
	const provider = providerSessionOf(meta);
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
		interruptions: interruptionsOf(events, threadId, messages),
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
				interruptions: interruptionsOf(events, meta.id, messages),
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
