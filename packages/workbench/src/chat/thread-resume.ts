import { clearNotices } from "./notice-queue";
import type { RestoreObservation } from "./restore-timing";
import { buildResumeNote, type ResumeBeat, type ResumeNote } from "./resume";
import type { ThreadContext } from "./thread-context";

export async function leave(
	context: ThreadContext,
	id: string,
	now: Date = new Date(),
): Promise<ResumeNote | null> {
	return context.store.enqueue(id, async () => {
		const meta = await context.store.get(id);
		const messages = await context.store.messages(id);
		const footprintSeq = (await context.bb.sessions.footprint(id)).length;
		const note = buildResumeNote(messages, meta, now);
		const leaveEvent = await context.store.appendThreadEvent(
			"thread.left",
			id,
			{
				messageCount: messages.length,
				footprintSeq,
				lastMessageAt: messages.at(-1)?.at ?? null,
			},
		);
		if (!note) {
			return null;
		}
		note.leaveSignature.footprintSeq = footprintSeq;
		note.leaveSignature.eventSeq = leaveEvent.eventSeq;
		note.leaveSignature.eventId = leaveEvent.id;
		meta.resumeNote = note;
		await context.store.saveMeta(meta);
		return note;
	});
}

export async function setResumeNote(
	context: ThreadContext,
	id: string,
	patch: { beats?: ResumeBeat[]; confirmed?: boolean },
	now: Date = new Date(),
): Promise<ResumeNote | undefined> {
	return context.store.enqueue(id, async () => {
		const meta = await context.store.get(id);
		if (!meta.resumeNote) {
			return undefined;
		}
		if (patch.beats !== undefined) {
			meta.resumeNote.beats = patch.beats;
		}
		if (patch.confirmed && !meta.resumeNote.confirmedAt) {
			meta.resumeNote.confirmedAt = now.toISOString();
		}
		await context.store.saveMeta(meta);
		return meta.resumeNote;
	});
}

export async function recordSwitch(
	context: ThreadContext,
	fromThreadId: string | null,
	toThreadId: string,
): Promise<void> {
	await context.store.appendThreadEvent("thread.switch", toThreadId, {
		fromThreadId,
		toThreadId,
	});
}

export async function recordRestored(
	context: ThreadContext,
	threadId: string,
	fromThreadId: string | null = null,
	observation: RestoreObservation = {},
): Promise<void> {
	await context.store.appendThreadEvent("thread.restored", threadId, {
		...observation,
		fromThreadId,
	});
}

export async function recordResumeNoteConsumed(
	context: ThreadContext,
	threadId: string,
	surface: string,
): Promise<void> {
	await context.store.appendThreadEvent(
		"thread.resume_note_consumed",
		threadId,
		{
			surface,
		},
	);
}

export async function recordResumeAction(
	context: ThreadContext,
	threadId: string,
	action: string,
	/** 可选归属标签（TF-0199）：分支行记 `branch:<threadId>`，文件行记路径。 */
	label?: string,
): Promise<void> {
	await context.store.appendThreadEvent("thread.resume_action", threadId, {
		action,
		...(label ? { label } : {}),
	});
}

/**
 * 恢复卡展示观测（TF-0199）：UI 在渲染出带分支行的恢复卡时报告本次展示了
 * 哪些行（`branch:<threadId>` 标签）。这是 fit 指标 7 的分母来源——服务端
 * GET 只读不落事件，渲染发生在客户端，所以由 UI 落这条观察。重复刷新由
 * UI 侧按恢复边界去重；折叠只做形状消毒，不替 UI 判断真假。
 */
export async function recordResumeCardShown(
	context: ThreadContext,
	threadId: string,
	branchRows: string[],
): Promise<void> {
	const rows = [...new Set(branchRows.filter((row) => row.trim()))].slice(
		0,
		32,
	);
	await context.store.appendThreadEvent("thread.resume_card_shown", threadId, {
		branchRows: rows,
	});
}

/**
 * 恢复卡 dismiss（TF-0198）：动作先落事件（notice-outcome 与熔断器共用的
 * 观测），随后同步清空该线程的模型侧注入队列——路由返回即队列已空。
 */
export async function dismissResumeCard(
	context: ThreadContext,
	threadId: string,
): Promise<void> {
	await recordResumeAction(context, threadId, "resume_card_dismissed");
	await clearNotices(context, threadId);
}

/**
 * 分支摘要折回（TF-0196 白名单，TF-0197 提供内容）：在父线程上记录
 * 「子分支的结构摘要已并入本线程恢复面」。payload 是观察不是结论——
 * 结构摘要的每条事实以 refs 溯源（世界事件 seq / 账本条目 / diff），
 * `refs` 由 validateThreadEvent 强制为字符串数组。
 */
export async function recordMergedBack(
	context: ThreadContext,
	threadId: string,
	payload: {
		fromThreadId: string;
		refs?: string[];
	} & Record<string, unknown>,
): Promise<void> {
	await context.store.appendThreadEvent(
		"thread.merged_back",
		threadId,
		payload,
	);
}
