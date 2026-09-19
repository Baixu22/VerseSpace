import type { Blackboard } from "../blackboard";

import type { ProcHandle } from "../supervisor";
import type { LiveClaudeSession } from "./claude-types";
import type { ForkOutcome } from "./fork";
import { notifySession } from "./notice-queue";
import type { RestoreObservation } from "./restore-timing";
import type { ResumeBeat, ResumeNote } from "./resume";
import type { ThreadContext } from "./thread-context";
import { fork } from "./thread-fork";
import { cancel, reload, remove } from "./thread-lifecycle";
import { promote } from "./thread-promotion";
import { ThreadRepository } from "./thread-repository";
import {
	dismissResumeCard,
	leave,
	recordMergedBack,
	recordRestored,
	recordResumeAction,
	recordResumeCardShown,
	recordResumeNoteConsumed,
	recordSwitch,
	setResumeNote,
} from "./thread-resume";
import { run } from "./thread-run";
import type { RunEvent, StoredMessage, ThreadMeta } from "./thread-types";

export type { ResumeBeat, ResumeNote } from "./resume";
export type {
	CollapsedGroupPart,
	MessagePart,
	PermissionMode,
	RunEvent,
	StoredMessage,
	StoredPart,
	ThreadMeta,
	ToolCallPart,
} from "./thread-types";

/** Public chat API; persistence, provider sessions and projections keep separate owners. */
export class ChatThreads {
	private readonly context: ThreadContext;
	constructor(bb: Blackboard) {
		this.context = {
			bb,
			store: new ThreadRepository(bb),
			running: new Map<string, ProcHandle | AbortController>(),
			live: new Map<string, LiveClaudeSession>(),
			observingInheritance: new Set<string>(),
			lineRouters: new Map<string, (line: string) => void>(),
			pendingVariants: new Map<string, string[]>(),
		};
	}
	async list(): Promise<ThreadMeta[]> {
		return this.context.store.list();
	}

	async create(title?: string): Promise<ThreadMeta> {
		return this.context.store.create(title);
	}

	async get(id: string): Promise<ThreadMeta> {
		return this.context.store.get(id);
	}

	async messages(id: string): Promise<StoredMessage[]> {
		return this.context.store.messages(id);
	}

	cancel(id: string): void {
		cancel(this.context, id);
	}

	async update(
		id: string,
		patch: Partial<Pick<ThreadMeta, "title" | "permissionMode" | "archived">>,
	): Promise<ThreadMeta> {
		return this.context.store.update(id, patch);
	}

	async leave(id: string, now: Date = new Date()): Promise<ResumeNote | null> {
		return leave(this.context, id, now);
	}

	async setResumeNote(
		id: string,
		patch: { beats?: ResumeBeat[]; confirmed?: boolean },
		now: Date = new Date(),
	): Promise<ResumeNote | undefined> {
		return setResumeNote(this.context, id, patch, now);
	}

	async promote(id: string): Promise<ThreadMeta> {
		return promote(this.context, id);
	}

	async fork(id: string, anchorMessageId: string): Promise<ForkOutcome> {
		return fork(this.context, id, anchorMessageId);
	}

	async recordSwitch(
		fromThreadId: string | null,
		toThreadId: string,
	): Promise<void> {
		return recordSwitch(this.context, fromThreadId, toThreadId);
	}

	async recordRestored(
		threadId: string,
		fromThreadId: string | null = null,
		observation: RestoreObservation = {},
	): Promise<void> {
		return recordRestored(this.context, threadId, fromThreadId, observation);
	}

	async recordResumeNoteConsumed(
		threadId: string,
		surface: string,
	): Promise<void> {
		return recordResumeNoteConsumed(this.context, threadId, surface);
	}

	async recordResumeAction(
		threadId: string,
		action: string,
		label?: string,
	): Promise<void> {
		return recordResumeAction(this.context, threadId, action, label);
	}

	/** TF-0199：恢复卡展示观测——fit 指标 7 的分母（渲染了才计数）。 */
	async recordResumeCardShown(
		threadId: string,
		branchRows: string[],
	): Promise<void> {
		return recordResumeCardShown(this.context, threadId, branchRows);
	}

	/** TF-0198：dismiss 记观测并撤回未投递注入；返回即队列已空。 */
	async dismissResumeCard(threadId: string): Promise<void> {
		return dismissResumeCard(this.context, threadId);
	}

	async recordMergedBack(
		threadId: string,
		payload: {
			fromThreadId: string;
			refs?: string[];
		} & Record<string, unknown>,
	): Promise<void> {
		return recordMergedBack(this.context, threadId, payload);
	}

	async remove(id: string): Promise<{ ok: boolean; reason?: string }> {
		return remove(this.context, id);
	}

	async reload(
		id: string,
	): Promise<{ ok: boolean; userText?: string; reason?: string }> {
		return reload(this.context, id);
	}

	run(
		id: string,
		text: string,
		emit: (event: RunEvent) => void,
		opts: { resend?: boolean } = {},
	): Promise<void> {
		return run(this.context, id, text, emit, opts);
	}

	async notifySession(
		writerId: string,
		notice: string,
		noticeId?: string,
	): Promise<"queued" | false> {
		return notifySession(this.context, writerId, notice, noticeId);
	}
}
