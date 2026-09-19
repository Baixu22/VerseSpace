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
): Promise<void> {
	await context.store.appendThreadEvent("thread.resume_action", threadId, {
		action,
	});
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
