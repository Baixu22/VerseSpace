import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blackboard } from "../blackboard";
import {
	extractFootprint,
	hashPathClaim,
	type ParsedStreamFootprint,
} from "../blackboard/footprint";
import { type FootprintUsed, writerSpoolDir } from "../blackboard/sessions";
import { pathExists, writeFileAtomic } from "../fs/atomic";
import { withPidLock } from "../fs/lockfile";
import { noticeIdForText } from "../runtime/notice-id";
import { type ProcHandle, spawnSupervised } from "../supervisor";
import type { WorkbenchConfig } from "../types/config";
import type { WorkbenchEvent } from "../types/event";
import { chatApiKey } from "./credentials";
import { buildVariants, clampFanout } from "./fanout";
import {
	buildForkDeclaration,
	type ForkAgentPlan,
	type ForkInheritance,
	type ForkLineage,
	type ForkOutcome,
	forkSlice,
} from "./fork";
import { httpEndpoint } from "./http-endpoint";
import {
	collectSignals,
	countUserTurns,
	deriveTitle,
	evaluatePromotion,
	type PromotionRecord,
	type PromotionSignal,
	promotionPatch,
	UNNAMED_TITLE,
} from "./promote";
import type { RestoreObservation } from "./restore-timing";
import { buildResumeNote, type ResumeBeat, type ResumeNote } from "./resume";

/**
 * The chat runtime: threads owned by the workbench server, backed by a
 * configurable provider — the local claude CLI (stream-json) or HTTP
 * streaming APIs (OpenAI Chat Completions / Responses, Anthropic Messages).
 *
 * Concurrency model — the product's focus:
 * - each thread serializes its own runs (one in-flight run per thread);
 * - distinct threads run in parallel (independent child processes / fetches);
 * - cancel hard-kills the child or aborts the fetch; thread state stays on
 *   disk, so nothing is lost.
 */

export type PermissionMode = "default" | "plan" | "acceptEdits";

export type { ResumeBeat, ResumeNote } from "./resume";

export interface ThreadMeta {
	id: string;
	title: string;
	createdAt: string;
	/**
	 * The claude session id. New threads mint a uuid at creation and pass it
	 * to the CLI via --session-id, so the thread directory name IS the claude
	 * session id (R1: the dual identifier is collapsed). --resume reuses it;
	 * a reload mints a fresh uuid (the conversation diverged).
	 */
	claudeSessionId?: string;
	/** Set once a run completed — the next run uses --resume. */
	hasResumableSession?: boolean;
	status: "idle" | "running";
	/** plan 模式下跑出的最后回复即计划，UI 渲染批准卡 */
	permissionMode: PermissionMode;
	archived?: boolean;
	/**
	 * 分叉计数（TF-0092 触发信号「同一条消息上第二次分叉」）：
	 * message id → 在该消息上分叉（含 reload）的次数。
	 */
	forks?: Record<string, number>;
	/** 晋升记录（TF-0092）：何时、因哪些信号、命名成什么。可观测，不参与自动动作。 */
	promotion?: PromotionRecord;
	/** 分叉血统（TF-0093）：本线程由哪个线程的哪条消息分叉而来。 */
	forkOf?: ForkLineage;
	/** 分叉后的真实 provider 继承观测；首次运行前字段为 pending。 */
	forkInheritance?: ForkInheritance;
	/** 准备恢复笔记（TF-0097）：离开车道时由 agent 起草，返回时呈现为有序叙事。 */
	resumeNote?: ResumeNote;
}

export type MessagePart =
	| { type: "text"; text: string }
	| {
			type: "tool-call";
			toolCallId: string;
			toolName: string;
			args: unknown;
			/** tool_result 回填后可展示 */
			result?: unknown;
	  };

export interface StoredMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	at: string;
	/** assistant 消息的结构化内容（text / tool-call）；user 消息省略 */
	parts?: MessagePart[];
	/** 扇出的备选文本（TF-0094）：不含主回答，最多 fanout-1 条。 */
	variants?: string[];
}

export type RunEvent = Record<string, unknown>;

/** How long an idle claude session stays alive between turns. */
const SESSION_IDLE_CLOSE_MS =
	Number(process.env.WORKBENCH_SESSION_IDLE_MS) || 5 * 60_000;

/** One in-flight user turn on a live claude session. */
interface ActiveTurn {
	assistantTexts: string[];
	messageParts: MessagePart[];
	stderr: string;
	pendingFootprints: Map<string, ParsedStreamFootprint>;
	fpQueue: Promise<void>;
	sawInit: boolean;
	finished: boolean;
	noticeAcked: boolean;
	noticeAckPromise: Promise<void>;
	noticeCount: number;
	onNoticesSent?: () => Promise<boolean>;
	inheritanceStarted: boolean;
	inheritancePromise: Promise<void>;
	emit: (event: RunEvent) => void;
	resolve: () => void;
}

/** A persistent claude child process owned by one thread. */
interface LiveClaudeSession {
	proc: ProcHandle;
	claudeSessionId: string | undefined;
	turn: ActiveTurn | null;
	/** Lines emitted before the first turn is attached (startup race buffer). */
	initialLines: string[];
	bufferInitialLines: boolean;
	/** Whether this process was started with --fork-session. */
	agentContextMode: "fresh" | "fork-session";
	forkPlan?: ForkAgentPlan;
	idleTimer?: ReturnType<typeof setTimeout>;
}

interface QueuedNotice {
	id: string;
	notice: string;
	at: string;
}

interface NoticeBatch {
	entries: QueuedNotice[];
}

interface NoticeSelection {
	entries: QueuedNotice[];
	/** Entries that fit the provider-side notice budget, in original order. */
	notices: string[];
}

/**
 * Keep the durable queue at-least-once when a caller enqueues more evidence
 * than one provider turn can reasonably carry. Oversized entries stay on disk
 * for a later attempt; only entries actually included in the prompt may be
 * acknowledged.
 */
function selectNoticeEntries(
	entries: QueuedNotice[],
	tokenBudget: number | undefined,
): NoticeSelection {
	const budget = Number.isFinite(tokenBudget)
		? Math.max(0, Math.trunc((tokenBudget as number) * 4))
		: 300 * 4;
	if (budget === 0) {
		return { entries: [], notices: [] };
	}
	let used = 0;
	const selected: QueuedNotice[] = [];
	for (const entry of entries) {
		const separator = selected.length === 0 ? 0 : 2;
		if (used + separator + entry.notice.length > budget) {
			continue;
		}
		selected.push(entry);
		used += separator + entry.notice.length;
	}
	return {
		entries: selected,
		notices: selected.map((entry) => entry.notice),
	};
}

interface SseConsumeResult {
	/** False when EOF arrived with an unterminated SSE frame. */
	complete: boolean;
}

const CHAT_COMMAND_DEFAULT =
	"claude -p --verbose --output-format stream-json --include-partial-messages";
// read lazily (not at module load) so tests can retarget the command per run
const chatCommand = () =>
	process.env.WORKBENCH_CHAT_COMMAND ?? CHAT_COMMAND_DEFAULT;

export class ChatThreads {
	private meta = new Map<string, ThreadMeta>();
	private queues = new Map<string, Promise<unknown>>();
	private running = new Map<string, ProcHandle | AbortController>();
	/** Live claude sessions (R2): the child persists across turns so the
	 * runtime can deliver notices into it between turns (streaming input). */
	private live = new Map<string, LiveClaudeSession>();
	private observingInheritance = new Set<string>();

	constructor(private bb: Blackboard) {}

	private async appendThreadEvent(
		type: string,
		threadId: string,
		payload: Record<string, unknown> = {},
	): Promise<WorkbenchEvent> {
		// The method's id is authoritative; a caller-supplied threadId must not
		// be able to redirect an observation to another thread.
		return this.bb.events.appendThread(type, { ...payload, threadId });
	}

	private dir(id: string): string {
		return join(this.bb.paths.root, "threads", id);
	}
	private metaFile(id: string): string {
		return join(this.dir(id), "meta.json");
	}
	private messagesFile(id: string): string {
		return join(this.dir(id), "messages.jsonl");
	}

	async list(): Promise<ThreadMeta[]> {
		const { readdir } = await import("node:fs/promises");
		try {
			const ids = await readdir(join(this.bb.paths.root, "threads"));
			const metas = await Promise.all(
				ids.map((id) => this.get(id).catch(() => null)),
			);
			return metas
				.filter((m): m is ThreadMeta => m !== null)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		} catch {
			return [];
		}
	}

	async create(title?: string): Promise<ThreadMeta> {
		// the thread id IS the claude session id: one identifier everywhere
		const id = randomUUID();
		const meta: ThreadMeta = {
			id,
			title: title?.trim() || "新对话",
			createdAt: new Date().toISOString(),
			claudeSessionId: id,
			status: "idle",
			permissionMode: "default",
		};
		await mkdir(this.dir(id), { recursive: true });
		await writeFile(this.metaFile(id), JSON.stringify(meta, null, 2), "utf8");
		await writeFile(this.messagesFile(id), "", "utf8");
		this.meta.set(id, meta);
		// register the thread as an agent writer (R1: citizens, not ghosts)
		await this.bb.sessions.register(id, "agent", meta.title);
		await this.appendThreadEvent("thread.created", id, { title: meta.title });
		return meta;
	}

	async get(id: string): Promise<ThreadMeta> {
		const cached = this.meta.get(id);
		if (cached) {
			return cached;
		}
		const meta = JSON.parse(
			await readFile(this.metaFile(id), "utf8"),
		) as ThreadMeta;
		this.meta.set(id, meta);
		return meta;
	}

	/** Copy only the parent's read-set facts; never copy its spool contents. */
	private async inheritParentFootprint(
		id: string,
		plan: ForkAgentPlan,
	): Promise<{ refs: string[]; comparable: boolean }> {
		const [view, lines] = await Promise.all([
			this.bb.sessions.readSetView(
				plan.sourceThreadId,
				plan.sourceFootprintSeq,
			),
			this.bb.sessions.footprint(plan.sourceThreadId),
		]);
		const lineRefs = new Map(
			lines.map((line) => [
				line.seq,
				line.eventId ? `footprint:${line.eventId}` : `footprintSeq:${line.seq}`,
			]),
		);
		const refs = new Set<string>();
		const used: FootprintUsed[] = [];
		for (const [, claim] of view.reads) {
			const { seq: _seq, spool: _spool, ...withoutLocalOnly } = claim;
			used.push(withoutLocalOnly);
			const ref = lineRefs.get(claim.seq);
			if (ref) {
				refs.add(ref);
			}
		}
		if (used.length === 0) {
			return { refs: [], comparable: false };
		}
		const refList = [...refs];
		await this.bb.sessions.recordActivity(id, {
			activity: `inherited-${randomUUID()}`,
			agent: id,
			used,
			generated: [],
			facets: {
				tool: "inherited",
				inherited: true,
				sourceWriter: plan.sourceThreadId,
				refs: refList,
			},
		});
		await this.bb.events.append({
			timestamp: new Date().toISOString(),
			source: "sessions",
			type: "footprint.inherited",
			payload: {
				writer: id,
				sourceWriter: plan.sourceThreadId,
				sourceFootprintSeq: plan.sourceFootprintSeq,
				refs: refList,
				paths: used.map((claim) => claim.path),
			},
		});
		return {
			refs: refList,
			comparable: used.some((claim) => claim.version != null),
		};
	}

	/** Record provider truth only after the first real assistant/result event. */
	private async observeForkInheritance(
		id: string,
		provider: string,
		observation: {
			agentContextInherited: boolean;
			premiseInherited: boolean;
			mode?: string;
			refs?: string[];
		},
	): Promise<void> {
		if (this.observingInheritance.has(id)) {
			return;
		}
		this.observingInheritance.add(id);
		try {
			const meta = await this.get(id);
			if (
				!meta.forkInheritance ||
				meta.forkInheritance.agentContextInherited !== null
			) {
				return;
			}
			const observed: ForkInheritance = {
				transcriptInherited: true,
				agentContextInherited: observation.agentContextInherited,
				premiseInherited: observation.premiseInherited,
				observedAt: new Date().toISOString(),
				provider,
			};
			meta.forkInheritance = observed;
			await this.saveMeta(meta);
			await this.appendThreadEvent("thread.inheritance_observed", id, {
				provider,
				transcriptInherited: true,
				agentContextInherited: observed.agentContextInherited,
				premiseInherited: observed.premiseInherited,
				...(observation.mode ? { mode: observation.mode } : {}),
				...(observation.refs?.length ? { refs: observation.refs } : {}),
			});
		} finally {
			this.observingInheritance.delete(id);
		}
	}

	async messages(id: string): Promise<StoredMessage[]> {
		const raw = await readFile(this.messagesFile(id), "utf8");
		return raw
			.split("\n")
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as StoredMessage);
	}

	private async appendMessage(
		id: string,
		message: StoredMessage,
	): Promise<void> {
		const { appendFile } = await import("node:fs/promises");
		await appendFile(
			this.messagesFile(id),
			`${JSON.stringify(message)}\n`,
			"utf8",
		);
	}

	private async saveMeta(meta: ThreadMeta): Promise<void> {
		this.meta.set(meta.id, meta);
		await writeFile(
			this.metaFile(meta.id),
			JSON.stringify(meta, null, 2),
			"utf8",
		);
	}

	/** Per-thread serialization: runs on one thread queue up, threads run in parallel. */
	private enqueue<T>(id: string, task: () => Promise<T>): Promise<T> {
		const prev = this.queues.get(id) ?? Promise.resolve();
		const next = prev.then(task, task);
		this.queues.set(
			id,
			// 判定（2026-09-13 收尾 §4.5 复核）：这里吞掉是**有意**的——队列
			// 链只需要一个「已结算」的接力棒，真实错误通过返回的 `next` 交给
			// 调用方，不是静默丢弃。
			next.catch(() => {}),
		);
		return next;
	}

	cancel(id: string): void {
		const handle = this.running.get(id);
		if (handle instanceof AbortController) {
			handle.abort();
		} else if (handle) {
			// supervisor kill = tree kill: on Windows the cmd.exe shim AND the
			// claude process under it both die (a bare kill() orphaned claude)
			void handle.kill();
		}
	}

	/** Patch mutable meta fields (title / permissionMode). */
	async update(
		id: string,
		patch: Partial<Pick<ThreadMeta, "title" | "permissionMode" | "archived">>,
	): Promise<ThreadMeta> {
		const meta = await this.get(id);
		if (patch.title !== undefined) {
			meta.title = patch.title;
		}
		if (patch.permissionMode !== undefined) {
			meta.permissionMode = patch.permissionMode;
		}
		if (patch.archived !== undefined) {
			meta.archived = patch.archived;
		}
		await this.saveMeta(meta);
		return meta;
	}

	// ── 准备恢复笔记（TF-0097）─────────────────────────────────────────
	// 离开车道的那一刻从既有事实推导一份恢复笔记（agent 起草），写进 meta。
	// 返回时呈现为有序叙事，用户可确认/编辑——确认不阻塞。笔记在离开时
	// 生成，不在返回时索取；返回时的『你不在时变了什么』由呈现层对比
	// leaveSignature 检测，不写回 meta。

	/**
	 * 离开车道时生成恢复笔记。空对话（无消息）不生成，返回 null。
	 * 幂等：重复调用只是覆盖（最新离开时刻为准）。
	 */
	async leave(id: string, now: Date = new Date()): Promise<ResumeNote | null> {
		return this.enqueue(id, async () => {
			const meta = await this.get(id);
			const messages = await this.messages(id);
			const footprintSeq = (await this.bb.sessions.footprint(id)).length;
			const note = buildResumeNote(messages, meta, now);
			const leaveEvent = await this.appendThreadEvent("thread.left", id, {
				messageCount: messages.length,
				footprintSeq,
				lastMessageAt: messages.at(-1)?.at ?? null,
			});
			if (!note) {
				return null;
			}
			note.leaveSignature.footprintSeq = footprintSeq;
			note.leaveSignature.eventSeq = leaveEvent.eventSeq;
			note.leaveSignature.eventId = leaveEvent.id;
			meta.resumeNote = note;
			await this.saveMeta(meta);
			return note;
		});
	}

	/**
	 * 用户编辑/确认恢复笔记。编辑替换 beats；确认置 confirmedAt。
	 * 没有笔记时返回 undefined（UI 不应到达此路径）。
	 */
	async setResumeNote(
		id: string,
		patch: { beats?: ResumeBeat[]; confirmed?: boolean },
		now: Date = new Date(),
	): Promise<ResumeNote | undefined> {
		return this.enqueue(id, async () => {
			const meta = await this.get(id);
			if (!meta.resumeNote) {
				return undefined;
			}
			if (patch.beats !== undefined) {
				meta.resumeNote.beats = patch.beats;
			}
			if (patch.confirmed && !meta.resumeNote.confirmedAt) {
				meta.resumeNote.confirmedAt = now.toISOString();
			}
			await this.saveMeta(meta);
			return meta.resumeNote;
		});
	}

	// ── 加法式晋升（TF-0092）───────────────────────────────────────────
	// 对话默认无名；命名发生在触发信号命中的**完成的轮次边界**，直接做
	// 不问（ADR-0009：B=3ms << K），撤销 = 改回标题，对话本身零变化。

	/**
	 * 在完成的轮次边界评估晋升信号并（命中时）直接晋升。
	 * 信号来源：轮次跨越、隔天恢复（从消息列表推导）+ meta.forks 里的
	 * 二次分叉。重复测试失败与提交信号由足迹侧喂入（本层暂未接入）。
	 */
	private async maybePromote(
		id: string,
		extraSignals: PromotionSignal[] = [],
	): Promise<ThreadMeta> {
		const meta = await this.get(id);
		const messages = await this.messages(id);
		// 二次分叉信号：任意一条消息被分叉（含 reload）达到 2 次
		const forkSignals: PromotionSignal[] = Object.entries(meta.forks ?? {})
			.filter(([, count]) => count >= 2)
			.map(([atMessageId]) => ({ kind: "second-fork", atMessageId }));
		const signals = collectSignals(messages, {
			extraSignals: [...forkSignals, ...extraSignals],
		});
		const verdict = evaluatePromotion({
			title: meta.title,
			userTurnCount: countUserTurns(messages),
			signals,
		});
		if (!verdict.promote) {
			return meta;
		}
		const patch = promotionPatch(messages, verdict.signals);
		meta.title = patch.title;
		meta.promotion = patch.promotion;
		await this.saveMeta(meta);
		return meta;
	}

	/**
	 * 手动晋升：任意时刻可把无名对话命名（一个手势，零仪式）。
	 * 已命名的对话原样返回——不覆盖用户可能改过的标题。
	 */
	async promote(id: string): Promise<ThreadMeta> {
		return this.enqueue(id, async () => {
			const meta = await this.get(id);
			if (meta.title !== UNNAMED_TITLE) {
				return meta;
			}
			const messages = await this.messages(id);
			const patch = promotionPatch(messages, [], new Date());
			if (patch.title === UNNAMED_TITLE) {
				return meta; // 空对话没有可派生的名字
			}
			meta.title = patch.title;
			meta.promotion = patch.promotion;
			await this.saveMeta(meta);
			return meta;
		});
	}

	// ── 追溯式分叉（TF-0093）───────────────────────────────────────────
	// 每条消息都是隐式分叉点：一次 POST 即分叉，零仪式（无标题输入、无
	// 对话框）。新线程继承锚点（含）之前的消息前缀，原线程逐字节不变；
	// 继承声明随响应返回（fork.ts: ForkDeclaration），不静默决定任何继承。

	/**
	 * 从源线程锚点消息处分叉出一个兄弟线程。
	 * 源线程的分叉计数 feeds TF-0092 的 second-fork 信号（与 reload 同层）。
	 */
	async fork(id: string, anchorMessageId: string): Promise<ForkOutcome> {
		return this.enqueue(id, async () => {
			// claude sessions stay alive BETWEEN turns (running holds the live
			// child for minutes) — refuse only when a turn is actually in flight
			if (this.turnInFlight(id)) {
				return { ok: false, reason: "线程正在运行" };
			}
			const source = await this.get(id);
			const sourceMessages = await this.messages(id);
			const sliced = forkSlice(sourceMessages, anchorMessageId);
			if (!sliced.ok) {
				return { ok: false, reason: "找不到锚点消息" };
			}
			const { inherited, anchor } = sliced;
			const config = await this.bb.config.load();
			const sourceFootprint = await this.bb.sessions.footprint(id);
			// Claude can only give a child the exact provider context when the
			// anchor is the current tail and the parent has a resumable session.
			// Older/mid-transcript forks stay fresh rather than claiming inheritance.
			const agentContextPlan: ForkAgentPlan | undefined =
				config.chat.provider === "claude" &&
				!this.live.get(id) &&
				source.hasResumableSession === true &&
				typeof source.claudeSessionId === "string" &&
				anchor.id === sourceMessages.at(-1)?.id
					? {
							provider: "claude",
							mode: "fork-session",
							sourceThreadId: id,
							sourceSessionId: source.claudeSessionId,
							sourceFootprintSeq: sourceFootprint.length,
						}
					: undefined;

			// 新线程：全新 uuid / 全新 agent 会话 / 无晋升记录 / 未归档；
			// 标题从继承前缀确定性推导（与晋升同规则）——零仪式，随时可改。
			const forkId = randomUUID();
			const forkMeta: ThreadMeta = {
				id: forkId,
				title: deriveTitle(inherited),
				createdAt: new Date().toISOString(),
				claudeSessionId: forkId,
				status: "idle",
				permissionMode: "default",
				forkOf: {
					sourceThreadId: id,
					sourceTitle: source.title,
					anchorMessageId,
					inheritedMessages: inherited.length,
					at: new Date().toISOString(),
					...(agentContextPlan ? { agentContextPlan } : {}),
				},
				forkInheritance: {
					transcriptInherited: true,
					agentContextInherited: null,
					premiseInherited: null,
				},
			};
			await mkdir(this.dir(forkId), { recursive: true });
			await writeFile(
				this.metaFile(forkId),
				JSON.stringify(forkMeta, null, 2),
				"utf8",
			);
			await writeFile(
				this.messagesFile(forkId),
				`${inherited.map((m) => JSON.stringify(m)).join("\n")}\n`,
				"utf8",
			);
			this.meta.set(forkId, forkMeta);
			await this.bb.sessions.register(forkId, "agent", forkMeta.title);

			// 源线程只动 meta.forks 计数；messages.jsonl 一个字节不动
			const forks = { ...(source.forks ?? {}) };
			forks[anchorMessageId] = (forks[anchorMessageId] ?? 0) + 1;
			source.forks = forks;
			await this.saveMeta(source);
			await this.appendThreadEvent("thread.forked", forkId, {
				sourceThreadId: id,
				anchorMessageId,
				transcriptInherited: true,
				...(agentContextPlan
					? {
							agentContextPlan: agentContextPlan.mode,
							sourceFootprintSeq: agentContextPlan.sourceFootprintSeq,
						}
					: {}),
			});

			return {
				ok: true,
				thread: forkMeta,
				declaration: buildForkDeclaration(
					anchor,
					inherited.length,
					undefined,
					agentContextPlan,
				),
			};
		});
	}

	/** UI observation hooks; all are append-only and intentionally fire-and-forget safe. */
	async recordSwitch(
		fromThreadId: string | null,
		toThreadId: string,
	): Promise<void> {
		await this.appendThreadEvent("thread.switch", toThreadId, {
			fromThreadId,
			toThreadId,
		});
	}

	async recordRestored(
		threadId: string,
		fromThreadId: string | null = null,
		observation: RestoreObservation = {},
	): Promise<void> {
		await this.appendThreadEvent("thread.restored", threadId, {
			...observation,
			fromThreadId,
		});
	}

	async recordResumeNoteConsumed(
		threadId: string,
		surface: string,
	): Promise<void> {
		await this.appendThreadEvent("thread.resume_note_consumed", threadId, {
			surface,
		});
	}

	async recordResumeAction(threadId: string, action: string): Promise<void> {
		await this.appendThreadEvent("thread.resume_action", threadId, { action });
	}

	/** Hard-delete a thread directory (guard: not while running). */
	async remove(id: string): Promise<{ ok: boolean; reason?: string }> {
		if (this.live.get(id)) {
			// a live session dies with its thread (the transcript lives here)
			this.cancel(id);
		} else if (this.running.get(id)) {
			return { ok: false, reason: "线程正在运行" };
		}
		const { rm } = await import("node:fs/promises");
		await rm(this.dir(id), { recursive: true, force: true });
		this.meta.delete(id);
		return { ok: true };
	}

	/** Drop the trailing assistant message; returns the user text to resend. */
	async reload(
		id: string,
	): Promise<{ ok: boolean; userText?: string; reason?: string }> {
		return this.enqueue(id, async () => {
			// claude sessions stay alive BETWEEN turns (running holds the live
			// child for minutes) — refuse only when a turn is actually in flight
			if (this.turnInFlight(id)) {
				return { ok: false, reason: "线程正在运行" };
			}
			const messages = await this.messages(id);
			const last = messages.at(-1);
			if (last?.role !== "assistant") {
				return { ok: false, reason: "最后一条不是助手消息" };
			}
			const kept = messages.slice(0, -1);
			const userText = kept.at(-1)?.text;
			if (!userText) {
				return { ok: false, reason: "找不到对应的用户消息" };
			}
			await writeFile(
				this.messagesFile(id),
				`${kept.map((m) => JSON.stringify(m)).join("\n")}${kept.length ? "\n" : ""}`,
				"utf8",
			);
			// TF-0092 触发信号「同一条消息上第二次分叉」：分叉锚点消息计数。
			const anchor = kept.at(-1)?.id;
			if (anchor) {
				const meta0 = await this.get(id);
				const forks = { ...(meta0.forks ?? {}) };
				forks[anchor] = (forks[anchor] ?? 0) + 1;
				meta0.forks = forks;
				await this.saveMeta(meta0);
			}
			// claude resume context diverges after truncation — mint a fresh
			// session id (the thread directory keeps its name; the NEXT claude
			// session gets the new uuid via --session-id). A live session is
			// killed first: it holds the OLD session.
			if (this.live.get(id)) {
				this.cancel(id);
				const deadline = Date.now() + 3000;
				while (this.live.get(id) && Date.now() < deadline) {
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
			}
			const meta = await this.get(id);
			meta.claudeSessionId = randomUUID();
			meta.hasResumableSession = false;
			await this.saveMeta(meta);
			return { ok: true, userText };
		});
	}

	/**
	 * Run one exchange. Streams NDJSON events to `emit`:
	 * {type:"user",message} → {type:"delta",text} → {type:"tool",part} →
	 * {type:"done",message} | {type:"error",message}.
	 * `opts.resend` skips re-appending the user message (reload flow).
	 */
	run(
		id: string,
		text: string,
		emit: (event: RunEvent) => void,
		opts: { resend?: boolean } = {},
	): Promise<void> {
		return this.enqueue(id, async () => {
			const meta = await this.get(id);
			if (!opts.resend) {
				const userMessage: StoredMessage = {
					id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					role: "user",
					text,
					at: new Date().toISOString(),
				};
				await this.appendMessage(id, userMessage);
				emit({ type: "user", message: userMessage });
				// TF-0092：对话默认保持无名——命名延迟到触发信号命中的轮次边界
				//（maybePromote），绝不要求用户先命名或分类。
			}

			meta.status = "running";
			await this.saveMeta(meta);

			const config = await this.bb.config.load();
			const chat = config.chat;
			const noticeBatch = await this.drainNotices(id);
			const selectedNotices = selectNoticeEntries(
				noticeBatch.entries,
				chat.noticeTokenBudget,
			);
			const notices = selectedNotices.notices;
			const noticeIds = selectedNotices.entries.map((entry) => entry.id);
			// Delivery is acknowledged after success, but the model can repair a
			// premise inside that very turn. Capture its causal lower bound now.
			const activityAfterEventId =
				notices.length > 0 ? (await this.bb.events.tail(1))[0]?.id : undefined;
			const ackNotices = async (): Promise<boolean> => {
				// Acknowledgement is cleanup, not a provider gate. If the process
				// dies or the lock is busy, keeping the file gives at-least-once
				// delivery and may repeat one notice rather than lose it.
				try {
					const acknowledged = await this.ackNotices(id, noticeIds);
					if (!acknowledged) {
						return false;
					}
					await this.bb.events.append({
						timestamp: new Date().toISOString(),
						source: "runtime",
						type: "premise_notice_delivered",
						payload: {
							writer: id,
							noticeIds,
							count: noticeIds.length,
							...(activityAfterEventId ? { activityAfterEventId } : {}),
							// Reads after a notice come back as footprints on the claude
							// channel. HTTP providers have no tool channel: their
							// post-notice reads are explicitly unobservable, never
							// silently assumed observable (TF-0142).
							readObservability:
								chat.provider === "claude" ? "footprint" : "unobservable",
						},
					});
					return true;
				} catch (err) {
					// at-least-once 语义保住了（下一轮重投），但失败必须可见，
					// 否则通知通道断裂表现为「再也没有送达信号」（2026-09-13 收尾 4.5）。
					console.error("[chat] premise notice ack failed:", err);
					return false;
				}
			};

			if (chat.provider === "claude") {
				// Notices are folded into the next user turn (append-only, so the
				// provider's existing context remains cache-safe).
				try {
					await this.runClaudeTurn(id, meta, text, emit, {
						resend: Boolean(opts.resend),
						precedingNotices: notices,
						onNoticesSent: ackNotices,
					});
				} catch (error) {
					emit({ type: "error", message: String(error).slice(0, 400) });
					// A spawn/finalization failure must not leave the durable thread
					// marked running forever. The provider notice file remains intact.
					const failed = await this.get(id).catch(() => null);
					if (failed) {
						failed.status = "idle";
						await this.saveMeta(failed).catch((err) => {
							// 落盘失败 = 线程永远停在 running，UI 的 busy 判定再也
							// 回不到 idle。会话已经出错，这一层不能再静默
							// （2026-09-13 收尾 §4.5 复核判定）。
							console.error(
								`[chat] 线程 ${id} 出错后无法把状态复位为 idle:`,
								err,
							);
						});
					}
				}
				return;
			}

			// ── HTTP providers: OpenAI Chat Completions / Responses, Anthropic ──
			const controller = new AbortController();
			this.running.set(id, controller);
			const messageParts: MessagePart[] = [];
			try {
				await this.runHttp(
					chat,
					id,
					emit,
					messageParts,
					controller.signal,
					notices,
					() =>
						this.observeForkInheritance(id, chat.provider, {
							agentContextInherited: true,
							premiseInherited: false,
							mode: "http-history",
						}),
					ackNotices,
				);
			} catch (error) {
				emit({ type: "error", message: String(error).slice(0, 400) });
			} finally {
				this.running.delete(id);
				const full = messageParts
					.filter((p): p is { type: "text"; text: string } => p.type === "text")
					.map((p) => p.text)
					.join("");
				if (full) {
					const variants = this.pendingVariants.get(id);
					this.pendingVariants.delete(id);
					const assistantMessage: StoredMessage = {
						id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						role: "assistant",
						text: full,
						at: new Date().toISOString(),
						parts: messageParts,
						...(variants?.length ? { variants } : {}),
					};
					await this.appendMessage(id, assistantMessage);
					emit({ type: "done", message: assistantMessage });
				} else {
					this.pendingVariants.delete(id);
				}
				const latest = await this.get(id);
				latest.status = "idle";
				await this.saveMeta(latest);
				// 完成的轮次边界：评估加法式晋升（TF-0092）
				await this.maybePromote(id);
			}
		});
	}

	// ── claude provider: one persistent streaming-input session per thread ──
	// The child stays alive between turns, so the runtime can deliver notices
	// into it between turns (R2 premise invalidation) — the S0-proven channel
	// after the messaging socket turned out to be headless-unavailable.

	private turnLine(text: string): string {
		// `--input-format stream-json` is newline-delimited. Keeping the delimiter
		// on every frame matters when a persistent session receives more than one
		// turn; without it, two writes can be buffered as one invalid JSON value.
		return `${JSON.stringify({
			type: "user",
			message: { role: "user", content: text },
		})}\n`;
	}

	private promptWithNotices(text: string, notices: string[]): string {
		if (notices.length === 0) {
			return text;
		}
		return [
			"[Workbench 前提通知；先核对事实，再处理当前请求]",
			notices.join("\n\n"),
			"[当前用户请求]",
			text,
		].join("\n\n");
	}

	/** Ack a notice only after the provider emitted a real assistant/result line. */
	private acknowledgeClaudeNotices(turn: ActiveTurn): void {
		if (!turn.onNoticesSent || turn.noticeAcked) {
			return;
		}
		turn.noticeAcked = true;
		turn.noticeAckPromise = (async () => {
			const acknowledged = await turn.onNoticesSent?.();
			if (acknowledged === false) {
				return;
			}
			turn.emit({ type: "notice_delivered", count: turn.noticeCount });
		})().catch((err) => {
			// The provider already accepted the turn; a logging failure must not
			// strand the chat turn. The durable notice ack itself is best effort.
			// 失败仍要可见（2026-09-13 收尾 4.5）。
			console.error("[chat] notice ack bookkeeping failed:", err);
		});
	}

	private async runClaudeTurn(
		id: string,
		meta: ThreadMeta,
		text: string,
		emit: (event: RunEvent) => void,
		opts: {
			resend: boolean;
			precedingNotices: string[];
			onNoticesSent?: () => Promise<boolean>;
		},
	): Promise<void> {
		const userTurn = this.turnLine(
			this.promptWithNotices(text, opts.precedingNotices),
		);
		const existing = this.live.get(id);
		const session =
			existing ?? (await this.ensureClaudeSession(id, meta, [userTurn]));
		if (session.idleTimer) {
			clearTimeout(session.idleTimer);
			session.idleTimer = undefined;
		}

		// per-turn state; the session-level line router fills it
		let resolveTurn!: () => void;
		const turnPromise = new Promise<void>((resolve) => {
			resolveTurn = resolve;
		});
		const turn: ActiveTurn = {
			assistantTexts: [],
			messageParts: [],
			stderr: "",
			pendingFootprints: new Map(),
			fpQueue: Promise.resolve(),
			sawInit: false,
			finished: false,
			noticeAcked: opts.precedingNotices.length === 0,
			noticeAckPromise: Promise.resolve(),
			noticeCount: opts.precedingNotices.length,
			onNoticesSent: opts.onNoticesSent,
			inheritanceStarted: false,
			inheritancePromise: Promise.resolve(),
			emit,
			resolve: () => {
				if (!turn.finished) {
					turn.finished = true;
					resolveTurn();
				}
			},
		};
		session.turn = turn;
		if (existing) {
			try {
				session.proc.writeStdin(userTurn);
			} catch (error) {
				emit({
					type: "error",
					message: `agent stdin 不可写：${String(error)}`,
				});
				turn.resolve();
			}
		} else {
			// The first line was queued by ensureClaudeSession. Replay any output
			// that raced the turn attachment before waiting for the result.
			session.bufferInitialLines = false;
			for (const line of session.initialLines.splice(0)) {
				this.lineRouters.get(id)?.(line);
			}
		}

		// the turn ends when the CLI reports this turn's result (or the
		// session dies) — the child itself stays alive for the next turn
		void session.proc.wait().then((outcome) => {
			if (!turn.finished) {
				if (outcome.error) {
					emit({
						type: "error",
						message: `agent 进程错误：${outcome.error}`,
					});
				} else if (!outcome.killed && outcome.exitCode !== 0) {
					emit({
						type: "error",
						message: `agent 退出码 ${outcome.exitCode}（会话已结束）`,
					});
				}
				turn.resolve();
			}
		});
		await turnPromise;

		// finalize the turn: footprints, messages, meta
		// the child stays alive between turns, but the turn is over — detach
		// it so session-level noise stops being routed and reload/fork see an
		// idle thread (SESSION_IDLE_CLOSE_MS keeps the child for minutes)
		session.turn = null;
		await turn.fpQueue;
		await turn.inheritancePromise;
		await turn.noticeAckPromise;
		for (const fp of turn.pendingFootprints.values()) {
			await this.bb.sessions.recordActivity(id, fp);
		}
		turn.pendingFootprints.clear();
		const full = turn.assistantTexts.join("");
		if (full || turn.messageParts.some((part) => part.type === "tool-call")) {
			const assistantMessage: StoredMessage = {
				id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				role: "assistant",
				text: full,
				at: new Date().toISOString(),
				parts: turn.messageParts,
			};
			await this.appendMessage(id, assistantMessage);
			emit({ type: "done", message: assistantMessage });
		}
		const latest = await this.get(id);
		latest.status = "idle";
		latest.claudeSessionId = session.claudeSessionId ?? latest.claudeSessionId;
		latest.hasResumableSession = turn.sawInit || latest.hasResumableSession;
		if (latest.permissionMode === "acceptEdits") {
			latest.permissionMode = "default";
		}
		await this.saveMeta(latest);

		// 完成的轮次边界：评估加法式晋升（TF-0092）
		await this.maybePromote(id);

		// the session lives on between turns; close it after idle so orphaned
		// children don't accumulate (it exits cleanly via stdin close)
		if (this.live.get(id) === session) {
			session.idleTimer = setTimeout(() => {
				session.proc.closeStdin();
			}, SESSION_IDLE_CLOSE_MS);
		}
	}

	/** Spawn (or adopt) the thread's persistent claude session. */
	private async ensureClaudeSession(
		id: string,
		meta: ThreadMeta,
		firstTurnLines: string[],
	): Promise<LiveClaudeSession> {
		const existing = this.live.get(id);
		if (existing) {
			return existing;
		}
		const claudeSessionId: string | undefined = meta.claudeSessionId;
		const forkPlan =
			!meta.hasResumableSession &&
			meta.forkOf?.agentContextPlan?.provider === "claude"
				? meta.forkOf.agentContextPlan
				: undefined;
		let agentContextMode: LiveClaudeSession["agentContextMode"] = "fresh";
		let commandLine = chatCommand();
		if (meta.permissionMode !== "default") {
			commandLine += ` --permission-mode ${meta.permissionMode}`;
		}
		// streaming input keeps the session alive across turns; the first
		// turn mints the session id (--session-id), respawns resume it
		commandLine += " --input-format stream-json";
		if (forkPlan) {
			// Claude creates a new provider session while inheriting the parent's
			// transcript/context. This is deliberately limited to a tail fork.
			commandLine += ` --resume ${forkPlan.sourceSessionId} --fork-session`;
			agentContextMode = "fork-session";
		} else if (claudeSessionId) {
			commandLine += meta.hasResumableSession
				? ` --resume ${claudeSessionId}`
				: ` --session-id ${claudeSessionId}`;
		}

		const initialLines: string[] = [];
		const proc = spawnSupervised(commandLine, {
			label: `chat:${id}`,
			registryDir: join(this.bb.paths.root, "proc"),
			cwd: this.bb.projectRoot,
			stdin: firstTurnLines.join("\n"),
			keepStdinOpen: true,
			stdinGate: (line) => line.includes('"subtype":"init"'),
			onLine: (line, kind) => {
				if (kind === "out") {
					const router = this.lineRouters.get(id);
					if (router) {
						router(line);
					} else if (initialLines.length < 512) {
						// The child can emit its init line before the router is installed.
						// Keep a bounded startup buffer rather than dropping the first turn.
						initialLines.push(line);
					}
				} else {
					const turn = this.live.get(id)?.turn;
					if (turn) {
						turn.stderr += `${line}\n`;
					}
				}
			},
		});
		this.running.set(id, proc);
		const session: LiveClaudeSession = {
			proc,
			claudeSessionId,
			turn: null,
			initialLines,
			bufferInitialLines: true,
			agentContextMode,
			forkPlan,
		};
		this.live.set(id, session);
		this.registerTurnRouter(id, session);
		await this.bb.sessions.register(id, "agent", meta.title);
		await this.bb.sessions.setStatus(id, "active");

		// reap on exit: cleanup happens once per process lifetime
		void proc.wait().then(async () => {
			this.live.delete(id);
			this.running.delete(id);
			const active = session.turn;
			if (active) {
				await active.fpQueue;
				for (const fp of active.pendingFootprints.values()) {
					await this.bb.sessions.recordActivity(id, fp);
				}
				active.resolve();
			}
			if (session.idleTimer) {
				clearTimeout(session.idleTimer);
			}
			const latest = await this.get(id);
			if (latest.status === "running") {
				latest.status = "idle";
				await this.saveMeta(latest);
			}
		});
		return session;
	}

	/** Wire the session-level stdout router (footprints + turn events). */
	private registerTurnRouter(id: string, session: LiveClaudeSession): void {
		const handleLine = (line: string): void => {
			if (!line.trim()) {
				return;
			}
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line) as Record<string, unknown>;
			} catch {
				return;
			}
			const sessionId =
				typeof event.session_id === "string" ? event.session_id : undefined;
			if (sessionId) {
				session.claudeSessionId = sessionId;
			}
			const turn = session.turn;
			if (!turn) {
				if (session.bufferInitialLines && session.initialLines.length < 512) {
					session.initialLines.push(line);
				}
				return; // no turn in flight: session-level noise
			}
			if (event.type === "system" && event.subtype === "init") {
				turn.sawInit = true;
			}
			// An assistant/result line is the first proof that the provider
			// actually consumed the fork context. Do not mark inheritance at fork
			// time or merely when stdin is queued behind the init gate.
			if (
				(event.type === "assistant" || event.type === "result") &&
				!turn.inheritanceStarted
			) {
				turn.inheritanceStarted = true;
				turn.inheritancePromise = (async () => {
					let inherited: { refs: string[]; comparable: boolean } = {
						refs: [],
						comparable: false,
					};
					if (session.agentContextMode === "fork-session" && session.forkPlan) {
						try {
							inherited = await this.inheritParentFootprint(
								id,
								session.forkPlan,
							);
						} catch (err) {
							// Provider context may still be inherited even when the local
							// footprint mirror is unavailable; record that distinction.
							// （fit 账本要数的继承观测证据，写失败不能无声——2026-09-13 收尾 4.5）
							console.error("[chat] fork footprint mirror failed:", err);
						}
					}
					await this.observeForkInheritance(id, "claude", {
						agentContextInherited: session.agentContextMode === "fork-session",
						premiseInherited:
							session.agentContextMode === "fork-session" &&
							inherited.comparable,
						mode: session.agentContextMode,
						refs: inherited.refs,
					});
				})().catch((err) => {
					// 继承观测（thread.inheritance_observed）写失败无声 =
					// fit 账本样本静默缺失（2026-09-13 收尾 4.5）。
					console.error("[chat] fork inheritance observation failed:", err);
				});
			}
			if (event.type === "stream_event") {
				const inner = event.event as
					| { type?: string; delta?: { type?: string; text?: string } }
					| undefined;
				if (
					inner?.type === "content_block_delta" &&
					inner.delta?.type === "text_delta" &&
					inner.delta.text
				) {
					const last = turn.messageParts.at(-1);
					if (last?.type === "text") {
						last.text += inner.delta.text;
					} else {
						turn.messageParts.push({ type: "text", text: inner.delta.text });
					}
					turn.assistantTexts.push(inner.delta.text);
					turn.emit({ type: "delta", text: inner.delta.text });
				}
			} else if (event.type === "assistant") {
				const message = event.message as
					| { content?: Array<Record<string, unknown>> }
					| undefined;
				for (const block of message?.content ?? []) {
					if (block.type === "tool_use") {
						const part: MessagePart = {
							type: "tool-call",
							toolCallId: String(block.id ?? ""),
							toolName: String(block.name ?? "tool"),
							args: block.input ?? {},
						};
						turn.messageParts.push(part);
						turn.emit({ type: "tool", part });
						const fp = extractFootprint(
							{ ...event, message: { content: [block] } },
							id,
						);
						if (fp) {
							turn.pendingFootprints.set(fp.activity, fp);
							turn.fpQueue = turn.fpQueue.then(async () => {
								// hash reads at call time: the version the agent's
								// premise is built on (spooled for R2 diffs)
								for (const used of fp.used) {
									Object.assign(
										used,
										await hashPathClaim(
											this.bb.projectRoot,
											used.path,
											writerSpoolDir(this.bb.paths, id),
											used.span,
										),
									);
								}
							});
						}
					}
				}
			} else if (event.type === "user") {
				// tool_result blocks ride on transcript "user" events
				const message = event.message as
					| { content?: Array<Record<string, unknown>> }
					| undefined;
				for (const block of message?.content ?? []) {
					if (block.type === "tool_result") {
						const toolCallId = String(block.tool_use_id ?? "");
						const part = turn.messageParts.find(
							(p) => p.type === "tool-call" && p.toolCallId === toolCallId,
						);
						if (part && part.type === "tool-call") {
							part.result = block.content ?? null;
							turn.emit({ type: "tool_result", part });
						}
						const fp = turn.pendingFootprints.get(toolCallId);
						if (fp) {
							turn.pendingFootprints.delete(toolCallId);
							if (block.is_error === true) continue;
							turn.fpQueue = turn.fpQueue.then(async () => {
								// hash writes at result time: the state the write
								// actually produced
								for (const gen of fp.generated) {
									Object.assign(
										gen,
										await hashPathClaim(this.bb.projectRoot, gen.path),
									);
								}
								await this.bb.sessions.recordActivity(id, fp);
							});
						}
					}
				}
			} else if (event.type === "result") {
				// A tool-use assistant event proves only that the provider started a
				// turn. Ack queued notices at the terminal result, so a crash between
				// tool invocation and the final result leaves them retryable.
				if (event.subtype === "success" && event.is_error !== true) {
					this.acknowledgeClaudeNotices(turn);
				}
				const result =
					typeof event.result === "string" ? event.result : undefined;
				if (
					event.is_error === true ||
					(typeof event.subtype === "string" &&
						event.subtype.startsWith("error"))
				) {
					turn.emit({ type: "error", message: result || "agent 回合执行失败" });
					turn.resolve();
					return;
				}
				if (result && turn.assistantTexts.length === 0) {
					turn.assistantTexts.push(result);
					turn.messageParts.push({ type: "text", text: result });
					turn.emit({ type: "delta", text: result });
				}
				// one result = one finished turn (streaming input mode)
				turn.resolve();
			}
		};
		this.lineRouters.set(id, handleLine);
	}

	/** Per-session line routers (the proc onLine delegates here). */
	private lineRouters = new Map<string, (line: string) => void>();

	/**
	 * A provider turn is actually executing: an HTTP controller is live, or a
	 * turn is attached to the persistent claude session. A live but idle child
	 * is NOT in flight — notices stay queue-and-fold regardless of channel
	 * state (TF-0142).
	 */
	private turnInFlight(id: string): boolean {
		return (
			this.running.get(id) instanceof AbortController ||
			Boolean(this.live.get(id)?.turn)
		);
	}

	/**
	 * R2: deliver a premise-invalidation notice into a writer's session.
	 * Notices are always queued and folded into the next real user turn. This
	 * keeps every tool read under an ActiveTurn and avoids a hidden result from
	 * ending the user's following turn early.
	 */
	async notifySession(
		writerId: string,
		notice: string,
		noticeId?: string,
	): Promise<"queued" | false> {
		if (!notice.trim()) return false;
		// Batch writers share the sessions registry but have no chat transcript or
		// stdin channel. Leave their notice pending instead of falsely marking it
		// delivered into a directory nobody will ever drain.
		if (!(await pathExists(this.metaFile(writerId)))) {
			return false;
		}
		const noticeFile = this.noticesFile(writerId);
		return withPidLock<"queued">(`${noticeFile}.lock`, async () => {
			await mkdir(this.dir(writerId), { recursive: true });
			const id = noticeId ?? noticeIdForText(writerId, notice);
			const existing = await this.readNoticeEntries(writerId);
			const sameId = existing.findIndex((entry) => entry.id === id);
			if (sameId >= 0) {
				// A reconcile pass may have queued the compact header before the
				// delivery pass rendered evidence. Keep the stable identity, but
				// upgrade the queued body so the provider receives the richest facts.
				if (existing[sameId]?.notice !== notice) {
					existing[sameId] = {
						...existing[sameId]!,
						notice,
						at: new Date().toISOString(),
					};
					await writeFileAtomic(
						noticeFile,
						`${existing.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
					);
				}
				return "queued";
			}
			if (existing.some((entry) => entry.notice === notice)) {
				return "queued";
			}
			await appendFile(
				noticeFile,
				`${JSON.stringify({
					id,
					notice,
					at: new Date().toISOString(),
				})}\n`,
				"utf8",
			);
			await this.bb.events.append({
				timestamp: new Date().toISOString(),
				source: "runtime",
				type: "premise_notice_queued",
				payload: {
					writer: writerId,
					noticeId: id,
					reason: this.turnInFlight(writerId)
						? "turn-in-flight"
						: "next-user-turn",
				},
			});
			return "queued";
		});
	}

	private noticesFile(id: string): string {
		return join(this.dir(id), "notices.jsonl");
	}

	private parseNoticeEntries(raw: string): QueuedNotice[] {
		const legacy = (line: string): QueuedNotice => ({
			id: `legacy-${createHash("sha256")
				.update(line, "utf8")
				.digest("hex")
				.slice(0, 16)}`,
			notice: line,
			at: "",
		});
		return raw
			.split("\n")
			.map((line) => {
				if (!line.trim()) {
					return null;
				}
				try {
					const parsed = JSON.parse(line) as {
						id?: unknown;
						notice?: unknown;
						at?: unknown;
					};
					if (typeof parsed.notice !== "string" || !parsed.notice.trim()) {
						// A syntactically valid but unknown row is still durable user
						// evidence. Keep the raw line during schema migrations instead
						// of silently deleting it on the next acknowledgement.
						return legacy(line);
					}
					const id =
						typeof parsed.id === "string" && parsed.id.length > 0
							? parsed.id
							: `legacy-${createHash("sha256")
									.update(line, "utf8")
									.digest("hex")
									.slice(0, 16)}`;
					return {
						id,
						notice: parsed.notice,
						at: typeof parsed.at === "string" ? parsed.at : "",
					};
				} catch {
					// Keep a legacy/plain-text line deliverable instead of silently
					// dropping it during a migration.
					return legacy(line);
				}
			})
			.filter((entry): entry is QueuedNotice => entry !== null);
	}

	private async readNoticeEntries(id: string): Promise<QueuedNotice[]> {
		try {
			return this.parseNoticeEntries(
				await readFile(this.noticesFile(id), "utf8"),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return [];
			}
			throw error;
		}
	}

	/**
	 * Read queued notices without deleting them. The caller acknowledges only
	 * after the combined provider turn has been accepted. This is at-least-once
	 * delivery: a crash after send and before ack may repeat a notice, but never
	 * loses one during the pre-send window.
	 */
	private async drainNotices(id: string): Promise<NoticeBatch> {
		const noticeFile = this.noticesFile(id);
		return withPidLock(`${noticeFile}.lock`, async () => {
			return { entries: await this.readNoticeEntries(id) };
		});
	}

	/** Remove only the batch that was actually sent; concurrent appends survive. */
	private async ackNotices(id: string, ids: string[]): Promise<boolean> {
		if (ids.length === 0) {
			return true;
		}
		const acknowledged = new Set(ids);
		const noticeFile = this.noticesFile(id);
		await withPidLock(`${noticeFile}.lock`, async () => {
			const entries = await this.readNoticeEntries(id);
			const remaining = entries.filter((entry) => !acknowledged.has(entry.id));
			if (remaining.length === 0) {
				await rm(noticeFile, { force: true });
				return;
			}
			await writeFileAtomic(
				noticeFile,
				`${remaining.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			);
		});
		return true;
	}

	/** History for HTTP providers: flat text turns from the stored transcript. */
	private async history(
		id: string,
	): Promise<Array<{ role: string; content: string }>> {
		const messages = await this.messages(id);
		return messages
			.filter((m) => m.text.trim().length > 0)
			.map((m) => ({ role: m.role, content: m.text }));
	}

	private async runHttp(
		chat: WorkbenchConfig["chat"],
		id: string,
		emit: (event: RunEvent) => void,
		messageParts: MessagePart[],
		signal: AbortSignal,
		precedingNotices: string[],
		onContextObserved?: () => Promise<void>,
		onNoticesSent?: () => Promise<boolean>,
	): Promise<void> {
		const provider = chat.provider;
		const key = chatApiKey(chat);
		if (!key && provider !== "claude") {
			emit({
				type: "error",
				message: "未配置 API Key——在 设置 中填写后重试",
			});
			return;
		}

		const history = await this.history(id);
		const noticesIncluded = precedingNotices.length === 0 || history.length > 0;
		if (precedingNotices.length > 0 && noticesIncluded) {
			const last = history.at(-1)!;
			last.content = this.promptWithNotices(last.content, precedingNotices);
		}
		const fanout = clampFanout(chat.fanout);
		const { url, headers, body } = this.buildHttpRequest(
			provider,
			key,
			chat,
			history,
		);

		let streamErrored = false;
		let streamMalformed = false;
		let streamTerminal = false;
		let malformedReported = false;
		const onSseData = (payload: string) => {
			if (!payload) {
				return;
			}
			if (payload === "[DONE]") {
				streamTerminal = true;
				return;
			}
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(payload) as Record<string, unknown>;
			} catch {
				streamMalformed = true;
				if (!malformedReported) {
					malformedReported = true;
					emit({ type: "error", message: "provider 返回了损坏的 SSE 数据" });
				}
				return;
			}
			let delta: string | undefined;
			if (provider === "anthropic") {
				if (event.type === "content_block_delta") {
					const d = event.delta as { type?: string; text?: string } | undefined;
					if (d?.type === "text_delta" && d.text) {
						delta = d.text;
					}
				} else if (event.type === "message_stop") {
					streamTerminal = true;
				} else if (event.type === "error") {
					streamErrored = true;
					const err = event.error as { message?: string } | undefined;
					emit({
						type: "error",
						message: err?.message ?? "anthropic stream error",
					});
				}
			} else if (provider === "openai-chat") {
				if (event.type === "error" || event.error) {
					streamErrored = true;
					const err = event.error as { message?: string } | undefined;
					emit({
						type: "error",
						message:
							err?.message ?? String(event.message ?? "openai stream error"),
					});
				}
				const choices = event.choices as
					| Array<{
							delta?: { content?: string };
							finish_reason?: string | null;
					  }>
					| undefined;
				delta = choices?.[0]?.delta?.content;
				if (choices?.[0]?.finish_reason) {
					streamTerminal = true;
				}
			} else {
				// openai-responses
				if (event.type === "response.output_text.delta") {
					delta = event.delta as string;
				} else if (
					event.type === "response.completed" ||
					event.type === "response.done"
				) {
					streamTerminal = true;
				} else if (
					event.type === "error" ||
					event.type === "response.failed" ||
					event.type === "response.incomplete"
				) {
					streamErrored = true;
					emit({
						type: "error",
						message: String(event.message ?? "responses error"),
					});
				}
			}
			if (delta) {
				const last = messageParts.at(-1);
				if (last?.type === "text") {
					last.text += delta;
				} else {
					messageParts.push({ type: "text", text: delta });
				}
				emit({ type: "delta", text: delta });
			}
		};

		// 主请求先发出（它是流式展示的主角），shadow 变体随后并发、只捕获
		// 不展示。shadow 的任何失败都被吞掉（runHttpShadow 返回空串）——
		// 备选是余光，绝不打扰主回答；cancel 经由同一个 signal 中止全部。
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});
		if (!response.ok || !response.body) {
			const detail = (await response.text()).slice(0, 300);
			emit({
				type: "error",
				message: `${provider} HTTP ${response.status}：${detail}`,
			});
			return;
		}
		const shadowPromises =
			fanout > 1
				? Array.from({ length: fanout - 1 }, () =>
						this.runHttpShadow(provider, url, headers, body, signal),
					)
				: [];

		const stream = await this.consumeSse(response, onSseData);
		// Only a completely consumed, non-error stream proves that the provider
		// accepted the combined turn. Header-level 2xx is not enough: a truncated
		// body must leave the notice for the next attempt.
		if (!stream.complete || !streamTerminal) {
			if (!streamErrored) {
				emit({
					type: "error",
					message: stream.complete
						? "provider 流没有结束标记，通知保留待重试"
						: "provider SSE 流在完整帧前结束，通知保留待重试",
				});
			}
		} else if (!streamErrored && !streamMalformed) {
			try {
				await onContextObserved?.();
			} catch {
				// Observability is additive; it must not turn a successful provider
				// response into a failed chat turn.
			}
			if (precedingNotices.length > 0 && noticesIncluded) {
				try {
					await onNoticesSent?.();
				} catch {
					// A failed acknowledgement leaves the durable queue for retry.
				}
			}
		}
		// 主回答结束：收下 shadow 文本，备选挂在 run() 的 finally 里组装
		const shadowTexts = await Promise.all(shadowPromises);
		const primaryText = messageParts
			.filter((p): p is { type: "text"; text: string } => p.type === "text")
			.map((p) => p.text)
			.join("");
		this.pendingVariants.set(
			id,
			buildVariants(primaryText, shadowTexts, fanout),
		);
	}

	/** 主回答结束后的备选暂存（run() 的 finally 组装 assistant 消息时取走）。 */
	private readonly pendingVariants = new Map<string, string[]>();

	private buildHttpRequest(
		provider: WorkbenchConfig["chat"]["provider"],
		key: string,
		chat: WorkbenchConfig["chat"],
		history: Array<{ role: string; content: string }>,
	): {
		url: string;
		headers: Record<string, string>;
		body: Record<string, unknown>;
	} {
		let url: string;
		const headers: Record<string, string> = {
			"content-type": "application/json",
		};
		const body: Record<string, unknown> = {};

		if (provider === "anthropic") {
			url = httpEndpoint(
				chat.baseUrl ?? "https://api.anthropic.com",
				"/v1/messages",
			);
			headers["x-api-key"] = key;
			headers["anthropic-version"] = "2023-06-01";
			body.model = chat.model ?? "claude-sonnet-4-5";
			body.max_tokens = chat.maxTokens ?? 1024;
			if (chat.temperature !== undefined) {
				body.temperature = chat.temperature;
			}
			body.stream = true;
			body.messages = history;
		} else if (provider === "openai-chat") {
			url = httpEndpoint(
				chat.baseUrl ?? "https://api.openai.com/v1",
				"/chat/completions",
			);
			headers.authorization = `Bearer ${key}`;
			body.model = chat.model ?? "gpt-4o-mini";
			body.messages = history;
			body.stream = true;
			if (chat.temperature !== undefined) {
				body.temperature = chat.temperature;
			}
			if (chat.maxTokens !== undefined) {
				body.max_tokens = chat.maxTokens;
			}
		} else {
			// openai-responses
			url = httpEndpoint(
				chat.baseUrl ?? "https://api.openai.com/v1",
				"/responses",
			);
			headers.authorization = `Bearer ${key}`;
			body.model = chat.model ?? "gpt-4o-mini";
			body.input = history.map((m) => ({ role: m.role, content: m.content }));
			body.stream = true;
			if (chat.temperature !== undefined) {
				body.temperature = chat.temperature;
			}
			if (chat.maxTokens !== undefined) {
				body.max_output_tokens = chat.maxTokens;
			}
			if (chat.effort) {
				body.reasoning = { effort: chat.effort };
			}
		}
		return { url, headers, body };
	}

	/**
	 * shadow 变体请求：与主回答同一个请求体并发发出，只把文本捕获成
	 * 备选——不 emit、不落盘；失败返回空串（buildVariants 会丢弃）。
	 */
	private async runHttpShadow(
		provider: WorkbenchConfig["chat"]["provider"],
		url: string,
		headers: Record<string, string>,
		body: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<string> {
		try {
			let text = "";
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			});
			if (!response.ok || !response.body) {
				return "";
			}
			await this.consumeSse(response, (payload) => {
				if (payload === "[DONE]") {
					return;
				}
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(payload) as Record<string, unknown>;
				} catch {
					return;
				}
				let delta: string | undefined;
				if (provider === "anthropic") {
					if (event.type === "content_block_delta") {
						const d = event.delta as
							| { type?: string; text?: string }
							| undefined;
						if (d?.type === "text_delta" && d.text) {
							delta = d.text;
						}
					}
				} else if (provider === "openai-chat") {
					const choices = event.choices as
						| Array<{ delta?: { content?: string } }>
						| undefined;
					delta = choices?.[0]?.delta?.content;
				} else {
					// openai-responses
					if (event.type === "response.output_text.delta") {
						delta = event.delta as string;
					}
				}
				if (delta) {
					text += delta;
				}
			});
			return text;
		} catch {
			return "";
		}
	}

	/** 统一的 SSE 消费循环：按空行分帧，data: 行逐条喂给回调。 */
	private async consumeSse(
		response: Response,
		onSseData: (payload: string) => void,
	): Promise<SseConsumeResult> {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let complete = true;
		const dispatch = (chunk: string): void => {
			for (const line of chunk.split(/\r?\n/)) {
				if (line.startsWith("data:")) {
					onSseData(line.slice(5).trim());
				}
			}
		};
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const chunks = buffer.split(/\r?\n\r?\n/);
			buffer = chunks.pop() ?? "";
			for (const chunk of chunks) {
				dispatch(chunk);
			}
		}
		buffer += decoder.decode();
		if (buffer.trim()) {
			// A final frame without the SSE blank-line delimiter may still contain
			// useful partial text, so feed it to the renderer but mark the stream
			// incomplete. Callers must not acknowledge durable notices in this case.
			complete = false;
			dispatch(buffer);
		}
		return { complete };
	}
}
