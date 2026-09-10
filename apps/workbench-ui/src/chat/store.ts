import { create } from "zustand";
import { apiFetch } from "../auth";

export type MessagePart =
	| { type: "text"; text: string }
	| {
			type: "tool-call";
			toolCallId: string;
			toolName: string;
			args: unknown;
			result?: unknown;
	  };

export interface StoredMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	at: string;
	status?: "running" | "complete";
	parts?: MessagePart[];
	/** 扇出的备选文本（TF-0094）：不含主回答，消息上的 chip 一击展开。 */
	variants?: string[];
}

export type PermissionMode = "default" | "plan" | "acceptEdits";

export interface ThreadMeta {
	id: string;
	title: string;
	createdAt: string;
	status: "idle" | "running";
	permissionMode: PermissionMode;
	archived?: boolean;
	/** 分叉/重跑计数（TF-0092/0095）：锚点消息 id → 次数。 */
	forks?: Record<string, number>;
	/** 分叉血统（TF-0093）：本线程由哪个线程的哪条消息分叉而来。 */
	forkOf?: {
		sourceThreadId: string;
		sourceTitle: string;
		anchorMessageId: string;
		inheritedMessages: number;
		at: string;
		agentContextPlan?: {
			provider: "claude";
			mode: "fork-session";
			sourceThreadId: string;
			sourceSessionId: string;
			sourceFootprintSeq: number;
		};
	};
	forkInheritance?: {
		transcriptInherited: true;
		agentContextInherited: boolean | null;
		premiseInherited: boolean | null;
		observedAt?: string;
		provider?: string;
	};
	/** 准备恢复笔记（TF-0097）：离开时 agent 起草，返回时呈现为有序叙事。 */
	resumeNote?: ResumeNote;
}

/** 服务端推导的续写建议（TF-0095，chat/suggest.ts）。 */
export interface Suggestion {
	text: string;
	kind: "option" | "question" | "next-step" | "diverge";
}

/** 服务端推导的决策点（TF-0095，chat/ledger.ts）。 */
export interface DecisionPoint {
	messageId: string;
	kind: "fork" | "variant";
	count: number;
	preview: string;
}

/** 切换离开时被收起的产物（TF-0096）。 */
export interface ParkedItem {
	id: string;
	kind: "draft";
	text: string;
	parkedAt: string;
}

/** 恢复笔记的一个节拍（TF-0097，packages/workbench chat/resume.ts 的镜像）。 */
export interface ResumeBeat {
	kind: "doing" | "decided" | "shifted" | "next";
	text: string;
	refs?: string[];
}

/** 离开车道时 agent 起草的恢复笔记（TF-0097）。 */
export interface ResumeNote {
	beats: ResumeBeat[];
	draftedAt: string;
	confirmedAt?: string;
	leaveSignature: {
		lastMessageAt: string;
		messageCount: number;
		footprintSeq?: number;
		eventSeq?: number;
		eventId?: string;
	};
}

export interface ReadSetDiffFact {
	path: string;
	observedVersion: string;
	currentVersion: string | null;
	writerId: string | null;
	writerKind: string | null;
	writerLabel: string | null;
	diff?: string;
	refs: string[];
	observedFootprintSeq: number;
	currentEventSeq: number | null;
}

export interface ResumeCardAnnotation {
	rule: "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8" | "R9" | "R10";
	label: string;
}

export interface ResumeCardNarrativeRow {
	kind: "doing" | "decided" | "next";
	text: string;
	refs: string[];
	annotation?: ResumeCardAnnotation;
}

export interface ResumeCardFactRow {
	path: string;
	summary: string;
	refs: string[];
	observedVersion?: string;
	currentVersion?: string | null;
	writerId?: string | null;
	writerLabel?: string | null;
	diff?: string;
	annotation?: ResumeCardAnnotation;
	source: "read-set" | "shifted" | "branch";
	branch?: {
		threadId: string;
		anchorMessageId: string;
		paths: string[];
		newForks: number;
	};
}

export interface ResumeCardView {
	coverage: { status: "available" | "unknown"; text: string };
	narrative: ResumeCardNarrativeRow[];
	facts: ResumeCardFactRow[];
	dismissed: boolean;
	inject: boolean;
}

export interface ReadSetDiff {
	status: "available" | "unknown";
	baseline: {
		footprintSeq: number;
		eventSeq: number | null;
		eventId: string | null;
	} | null;
	checkedAt: string;
	compared: number;
	comparable: number;
	excludedDurable: number;
	unsupported: number;
	uncoveredTools: string[];
	stale: ReadSetDiffFact[];
}

/** 分叉响应携带的继承声明（packages/workbench fork.ts 的 ForkDeclaration）。 */
interface ForkDeclaration {
	inheritedMessages: number;
	anchor: { id: string; role: string; at: string };
	transcriptInherited: true;
	agentContextInherited: boolean | null;
	premiseInherited: boolean | null;
	inheritanceObserved: boolean;
	agentContextPlan?: "fork-session";
	freshAgentSession: true;
	freshPromotion: true;
	freshForkCounts: true;
	freshArchived: true;
}

interface ChatState {
	threads: ThreadMeta[];
	activeId: string | null;
	messages: Record<string, StoredMessage[]>;
	/** The thread with an in-flight run, if any. */
	runningThreadId: string | null;
	/** 最近一次分叉的继承声明（TF-0093）：切线程或手动关闭后消失。 */
	forkNotice: {
		text: string;
		threadId: string;
		anchorMessageId: string;
	} | null;
	/** 当前线程的系统提议下一步（TF-0095），随线程 GET 刷新。 */
	suggestions: Suggestion[];
	/** 当前线程的决策账本（TF-0095），无分歧时为空数组＝完全不渲染。 */
	decisionPoints: DecisionPoint[];
	/** 各线程的实时草稿镜像（TF-0096）：composer 文本随键入镜像到这里。 */
	drafts: Record<string, string>;
	/** 各线程的停放快照（TF-0096）：切换离开时收起的产物。 */
	parked: Record<string, ParkedItem[]>;
	/** 当前线程的恢复笔记（TF-0097）：离开时生成、返回时呈现。null = 无笔记。 */
	resumeNote: ResumeNote | null;
	/** 返回时检测『你不在时变了什么』（TF-0097）：离开后新增的消息条数。 */
	resumeDelta: number;
	/** R2′ restore-time read-set facts; null means no card or unknown baseline. */
	readSetDiff: ReadSetDiff | null;
	resumeCard: ResumeCardView | null;
	resumeCardDismissed: boolean;
	resumeCardRevealed: boolean;
	init(): Promise<void>;
	createThread(): Promise<void>;
	switchThread(id: string): Promise<void>;
	send(text: string): Promise<void>;
	reload(): Promise<void>;
	fork(messageId: string): Promise<string | null>;
	dismissForkNotice(): void;
	setDraft(threadId: string, text: string): void;
	/** 切换离开时收起草稿：进停放快照，composer 清空（清场）。 */
	parkDraft(threadId: string, text: string): void;
	discardParked(threadId: string, itemId: string): void;
	clearParked(threadId: string): void;
	/** 确认恢复笔记（TF-0097）：置 confirmedAt，不阻塞。 */
	confirmResumeNote(): Promise<void>;
	/** 编辑恢复笔记的一个节拍（TF-0097）。 */
	editResumeBeat(index: number, text: string): Promise<void>;
	consumeResumeNote(surface: string): Promise<void>;
	dismissResumeCard(): Promise<void>;
	revealResumeCard(): void;
	recordResumeAction(action: string): Promise<void>;
	cancel(): void;
	setPlanMode(enabled: boolean): Promise<void>;
	deleteThread(id: string): Promise<void>;
	setArchived(id: string, archived: boolean): Promise<void>;
	renameThread(id: string, title: string): Promise<void>;
	feedback(messageId: string, kind: "positive" | "negative"): Promise<void>;
}

const EMPTY: StoredMessage[] = [];

const PARKED_STORAGE_KEY = "workbench.chat.parked.v1";

/** Parked drafts are local UI state, but they must survive an app restart. */
function loadParked(): Record<string, ParkedItem[]> {
	try {
		const storage = globalThis.localStorage;
		if (!storage) {
			return {};
		}
		const parsed: unknown = JSON.parse(
			storage.getItem(PARKED_STORAGE_KEY) ?? "{}",
		);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		const result: Record<string, ParkedItem[]> = {};
		for (const [threadId, value] of Object.entries(parsed)) {
			if (!Array.isArray(value)) {
				continue;
			}
			const items = value.filter(
				(item): item is ParkedItem =>
					Boolean(item) &&
					typeof item === "object" &&
					(item as ParkedItem).kind === "draft" &&
					typeof (item as ParkedItem).id === "string" &&
					typeof (item as ParkedItem).text === "string" &&
					typeof (item as ParkedItem).parkedAt === "string",
			);
			if (items.length > 0) {
				result[threadId] = items;
			}
		}
		return result;
	} catch {
		// Private browsing and disabled webviews can reject storage access.
		return {};
	}
}

function persistParked(parked: Record<string, ParkedItem[]>): void {
	try {
		globalThis.localStorage?.setItem(
			PARKED_STORAGE_KEY,
			JSON.stringify(parked),
		);
	} catch {
		// A full/disabled storage area must not block composing or switching.
	}
}

/** Invalidate in-flight selection work whenever the visible lane changes. */
let switchGeneration = 0;

/** 线程 GET 载荷：meta + messages + 服务端推导的建议与决策账本（TF-0095）+ 恢复笔记（TF-0097）。 */
interface ThreadGetResponse {
	meta: ThreadMeta;
	messages: StoredMessage[];
	suggestions: Suggestion[];
	decisionPoints: DecisionPoint[];
	resumeNote: ResumeNote | null;
	readSetDiff?: ReadSetDiff;
	resumeCard?: ResumeCardView | null;
	resumeCardDismissed?: boolean;
}

export const useChatStore = create<ChatState>((set, get) => ({
	threads: [],
	activeId: null,
	messages: {},
	runningThreadId: null,
	forkNotice: null,
	suggestions: [],
	decisionPoints: [],
	drafts: {},
	parked: loadParked(),
	resumeNote: null,
	resumeDelta: 0,
	readSetDiff: null,
	resumeCard: null,
	resumeCardDismissed: false,
	resumeCardRevealed: false,

	async init() {
		const threads = await apiFetch("/api/chat/threads").then(
			(r) => r.json() as Promise<ThreadMeta[]>,
		);
		set({ threads });
		if (threads[0]) {
			await get().switchThread(threads[0].id);
		}
	},

	async createThread() {
		const generation = ++switchGeneration;
		const thread = await apiFetch("/api/chat/threads", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		}).then((r) => r.json() as Promise<ThreadMeta>);
		set((s) => {
			const stale = generation !== switchGeneration;
			return {
				threads: [thread, ...s.threads.filter((item) => item.id !== thread.id)],
				messages: { ...s.messages, [thread.id]: [] },
				...(stale
					? {}
					: {
							activeId: thread.id,
							runningThreadId: null,
							resumeNote: null,
							resumeDelta: 0,
							readSetDiff: null,
							resumeCard: null,
							resumeCardDismissed: false,
							resumeCardRevealed: false,
						}),
			};
		});
	},

	async switchThread(id) {
		if (get().activeId === id) {
			return;
		}
		const generation = ++switchGeneration;
		// TF-0096 清场：离开的车道收起草稿进停放快照，composer 从干净开始。
		// 返回时快照以可筛选列表呈现，恢复或丢弃由用户决定。
		const prevId = get().activeId;
		set((s) => {
			const parked = { ...s.parked };
			const drafts = { ...s.drafts };
			const prev = s.activeId;
			if (prev) {
				const text = (drafts[prev] ?? "").trim();
				if (text) {
					parked[prev] = [
						...(parked[prev] ?? []),
						{
							id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
							kind: "draft" as const,
							text,
							parkedAt: new Date().toISOString(),
						},
					];
				}
				delete drafts[prev];
			}
			persistParked(parked);
			return {
				parked,
				drafts,
				activeId: id,
				forkNotice: null,
				suggestions: [],
				decisionPoints: [],
				resumeNote: null,
				resumeDelta: 0,
				readSetDiff: null,
				resumeCard: null,
				resumeCardDismissed: false,
				resumeCardRevealed: false,
			};
		});
		// TF-0097：离开 prev 时 fire-and-forget 生成恢复笔记（agent 起草）。
		// 不阻塞切换、失败吞掉——笔记是余光，不是切换的前置条件。
		if (prevId && prevId !== id) {
			void apiFetch(`/api/chat/threads/${prevId}/leave`, {
				method: "POST",
			}).catch(() => {});
		}
		const data = await apiFetch(`/api/chat/threads/${id}`).then(
			(r) => r.json() as Promise<ThreadGetResponse>,
		);
		if (generation !== switchGeneration || get().activeId !== id) {
			return;
		}
		set((s) => {
			// TF-0097：返回时检测『你不在时变了什么』——对比离开签名与当前消息数。
			// 纯呈现层，不写回 meta（笔记在离开时生成，不在返回时索取）。
			const delta =
				data.resumeNote &&
				data.messages.length > data.resumeNote.leaveSignature.messageCount
					? data.messages.length - data.resumeNote.leaveSignature.messageCount
					: 0;
			return {
				messages: { ...s.messages, [id]: data.messages },
				suggestions: data.suggestions,
				decisionPoints: data.decisionPoints,
				resumeNote: data.resumeNote,
				resumeDelta: delta,
				readSetDiff: data.readSetDiff ?? null,
				resumeCard: data.resumeCard ?? null,
				resumeCardDismissed: Boolean(data.resumeCardDismissed),
				resumeCardRevealed: false,
				threads: s.threads.some((t) => t.id === id)
					? s.threads.map((t) => (t.id === id ? { ...t, ...data.meta } : t))
					: [data.meta, ...s.threads],
			};
		});
		if (generation !== switchGeneration || get().activeId !== id) {
			return;
		}
		// Lifecycle observations are best-effort and only record a switch that
		// actually loaded its target; stale/failed races must not inflate stats.
		await apiFetch(`/api/chat/threads/${id}/switch`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ fromThreadId: prevId }),
		}).catch(() => {});
		if (generation !== switchGeneration || get().activeId !== id) {
			return;
		}
		await apiFetch(`/api/chat/threads/${id}/restore`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				fromThreadId: prevId,
				resumeCardVisible: Boolean(
					data.resumeCard && !data.resumeCardDismissed,
				),
				lastMessageId: data.messages.at(-1)?.id ?? null,
			}),
		}).catch(() => {});
	},

	setDraft(threadId, text) {
		set((s) => ({ drafts: { ...s.drafts, [threadId]: text } }));
	},

	parkDraft(threadId, text) {
		set((s) => {
			const parked = { ...s.parked };
			const drafts = { ...s.drafts };
			if (text.trim()) {
				parked[threadId] = [
					...(parked[threadId] ?? []),
					{
						id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
						kind: "draft" as const,
						text,
						parkedAt: new Date().toISOString(),
					},
				];
			}
			delete drafts[threadId];
			persistParked(parked);
			return { parked, drafts };
		});
	},

	discardParked(threadId, itemId) {
		set((s) => {
			const parked = {
				...s.parked,
				[threadId]: (s.parked[threadId] ?? []).filter((p) => p.id !== itemId),
			};
			if (parked[threadId]?.length === 0) {
				delete parked[threadId];
			}
			persistParked(parked);
			return { parked };
		});
	},

	clearParked(threadId) {
		set((s) => {
			const parked = { ...s.parked };
			delete parked[threadId];
			persistParked(parked);
			return { parked };
		});
	},

	async confirmResumeNote() {
		const threadId = get().activeId;
		if (!threadId) {
			return;
		}
		const generation = switchGeneration;
		const updated = await apiFetch(
			`/api/chat/threads/${threadId}/resume-note`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ confirmed: true }),
			},
		).then((r) => r.json() as Promise<ResumeNote>);
		if (generation === switchGeneration && get().activeId === threadId) {
			set({ resumeNote: updated });
		}
	},

	async editResumeBeat(index, text) {
		const threadId = get().activeId;
		const note = get().resumeNote;
		if (!threadId || !note || index < 0 || index >= note.beats.length) {
			return;
		}
		const generation = switchGeneration;
		const beats = note.beats.map((beat, i) =>
			i === index ? { ...beat, text } : beat,
		);
		const updated = await apiFetch(
			`/api/chat/threads/${threadId}/resume-note`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ beats }),
			},
		).then((r) => r.json() as Promise<ResumeNote>);
		if (generation === switchGeneration && get().activeId === threadId) {
			set({ resumeNote: updated });
		}
	},

	async consumeResumeNote(surface) {
		const threadId = get().activeId;
		if (!threadId) {
			return;
		}
		await apiFetch(`/api/chat/threads/${threadId}/resume-note/consume`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ surface }),
		}).catch(() => {});
	},

	revealResumeCard() {
		set({ resumeCardRevealed: true });
	},

	async dismissResumeCard() {
		const threadId = get().activeId;
		if (!threadId) {
			return;
		}
		const generation = switchGeneration;
		set({ resumeCardDismissed: true, resumeCardRevealed: false });
		await apiFetch(`/api/chat/threads/${threadId}/resume-note/dismiss`, {
			method: "POST",
		}).catch(() => {});
		if (generation !== switchGeneration || get().activeId !== threadId) {
			return;
		}
	},

	async recordResumeAction(action) {
		const threadId = get().activeId;
		if (!threadId) {
			return;
		}
		await apiFetch(`/api/chat/threads/${threadId}/resume-action`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action }),
		}).catch(() => {});
	},

	cancel() {
		const id = get().runningThreadId;
		if (id) {
			void apiFetch(`/api/chat/threads/${id}/cancel`, { method: "POST" });
		}
	},

	async reload() {
		const threadId = get().activeId;
		if (!threadId || get().runningThreadId) {
			return;
		}
		const outcome = await apiFetch(`/api/chat/threads/${threadId}/reload`, {
			method: "POST",
		}).then(
			(r) =>
				r.json() as Promise<{
					ok: boolean;
					userText?: string;
					reason?: string;
				}>,
		);
		if (!outcome.ok || !outcome.userText) {
			return;
		}
		// server already truncated the trailing assistant message; re-run it
		set((s) => ({
			runningThreadId: threadId,
			messages: {
				...s.messages,
				[threadId]: (s.messages[threadId] ?? EMPTY).map((m, index, all) =>
					index === all.length - 1 &&
					m.status === "complete" &&
					m.role === "assistant"
						? { ...m, text: "", parts: [], status: "running" as const }
						: m,
				),
			},
		}));
		const assistantId = (get().messages[threadId] ?? EMPTY).at(-1)?.id;
		const patchAssistant = (patch: Partial<StoredMessage>) =>
			set((s) => ({
				messages: {
					...s.messages,
					[threadId]: (s.messages[threadId] ?? EMPTY).map((m) =>
						m.id === assistantId ? { ...m, ...patch } : m,
					),
				},
			}));
		try {
			const response = await apiFetch(
				`/api/chat/threads/${threadId}/messages`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text: outcome.userText, resend: true }),
				},
			);
			const reader = response.body?.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = (await reader?.read()) ?? {
					done: true,
					value: undefined,
				};
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) {
						continue;
					}
					const event = JSON.parse(line) as {
						type: string;
						text?: string;
						message?: StoredMessage;
					};
					if (event.type === "delta" && event.text) {
						const current = (get().messages[threadId] ?? EMPTY).find(
							(m) => m.id === assistantId,
						);
						patchAssistant({ text: (current?.text ?? "") + event.text });
					} else if (event.type === "done" && event.message) {
						patchAssistant({
							id: event.message.id,
							text: event.message.text,
							parts: event.message.parts,
							variants: event.message.variants,
							status: "complete",
						});
					} else if (event.type === "error") {
						patchAssistant({
							text: `⚠ ${event.text ?? "重载失败"}`,
							status: "complete",
						});
					}
				}
			}
		} finally {
			set((s) => ({
				runningThreadId:
					s.runningThreadId === threadId ? null : s.runningThreadId,
			}));
			// 轮次边界刷新：meta（标题/晋升）+ 建议 + 决策账本（TF-0095）
			await refreshThread(threadId);
		}
	},

	/**
	 * 追溯式分叉（TF-0093）：新线程继承锚点（含）之前的消息前缀，
	 * 原线程不动。新线程先入列表，用户确认反馈后再通过明确动作进入。
	 */
	async fork(messageId) {
		const threadId = get().activeId;
		if (!threadId || get().runningThreadId) {
			return null;
		}
		const generation = switchGeneration;
		const outcome = await apiFetch(`/api/chat/threads/${threadId}/fork`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ anchorMessageId: messageId }),
		}).then(
			(r) =>
				r.json() as Promise<{
					ok: boolean;
					thread?: ThreadMeta;
					declaration?: ForkDeclaration;
				}>,
		);
		if (!outcome.ok || !outcome.thread) {
			return null;
		}
		const forkedThread = outcome.thread;
		// 先入列表：源线程保持可见，用户确认结果后再主动跳转。
		set((s) => ({
			threads: [
				forkedThread,
				...s.threads.filter((item) => item.id !== forkedThread.id),
			],
		}));
		if (generation !== switchGeneration || get().activeId !== threadId) {
			return null;
		}
		// Keep the source visible so the success state completes before the user
		// follows the explicit jump action. Creation stays zero-ceremony while
		// navigation remains predictable.
		const d = outcome.declaration;
		set((s) => ({
			threads: s.threads.map((thread) =>
				thread.id === threadId
					? {
							...thread,
							forks: {
								...thread.forks,
								[messageId]: (thread.forks?.[messageId] ?? 0) + 1,
							},
						}
					: thread,
			),
			forkNotice: d
				? {
						text: `已分叉：继承「${forkedThread.forkOf?.sourceTitle ?? "原对话"}」的前 ${d.inheritedMessages} 条消息（含锚点）；agent 会话从新开始，原对话保持不变。`,
						threadId: forkedThread.id,
						anchorMessageId: messageId,
					}
				: null,
		}));
		return forkedThread.id;
	},
	dismissForkNotice() {
		set({ forkNotice: null });
	},

	async setPlanMode(enabled: boolean) {
		const id = get().activeId;
		if (!id) {
			return;
		}
		await apiFetch(`/api/chat/threads/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ permissionMode: enabled ? "plan" : "default" }),
		});
		set((s) => ({
			threads: s.threads.map((t) =>
				t.id === id
					? {
							...t,
							permissionMode: (enabled ? "plan" : "default") as PermissionMode,
						}
					: t,
			),
		}));
	},

	async deleteThread(id: string) {
		if (get().activeId === id) {
			++switchGeneration;
		}
		await apiFetch(`/api/chat/threads/${id}`, { method: "DELETE" });
		set((s) => {
			const messages = { ...s.messages };
			delete messages[id];
			const threads = s.threads.filter((t) => t.id !== id);
			const parked = { ...s.parked };
			delete parked[id];
			persistParked(parked);
			const deletingActive = s.activeId === id;
			return {
				threads,
				messages,
				parked,
				activeId: deletingActive ? (threads[0]?.id ?? null) : s.activeId,
				...(deletingActive
					? {
							suggestions: [],
							decisionPoints: [],
							resumeNote: null,
							resumeDelta: 0,
							readSetDiff: null,
							resumeCard: null,
							resumeCardDismissed: false,
							resumeCardRevealed: false,
						}
					: {}),
			};
		});
	},

	async setArchived(id: string, archived: boolean) {
		await apiFetch(`/api/chat/threads/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ archived }),
		});
		set((s) => ({
			threads: s.threads.map((t) => (t.id === id ? { ...t, archived } : t)),
		}));
	},

	async renameThread(id: string, title: string) {
		await apiFetch(`/api/chat/threads/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title }),
		});
		set((s) => ({
			threads: s.threads.map((t) => (t.id === id ? { ...t, title } : t)),
		}));
	},

	async feedback(messageId: string, kind: "positive" | "negative") {
		const threadId = get().activeId;
		if (!threadId) {
			return;
		}
		await apiFetch("/api/chat/feedback", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ threadId, messageId, kind }),
		});
	},

	async send(text) {
		const threadId = get().activeId;
		if (!threadId || get().runningThreadId) {
			return;
		}
		const generation = switchGeneration;
		const userMessage: StoredMessage = {
			id: `local-${Date.now()}`,
			role: "user",
			text,
			at: new Date().toISOString(),
			status: "complete",
		};
		const assistantId = `local-a-${Date.now()}`;
		const assistantPlaceholder: StoredMessage = {
			id: assistantId,
			role: "assistant",
			text: "",
			at: new Date().toISOString(),
			status: "running",
		};
		set((s) => ({
			messages: {
				...s.messages,
				[threadId]: [
					...(s.messages[threadId] ?? EMPTY),
					userMessage,
					assistantPlaceholder,
				],
			},
			runningThreadId: threadId,
		}));

		const patchAssistant = (patch: Partial<StoredMessage>) =>
			set((s) => ({
				messages: {
					...s.messages,
					[threadId]: (s.messages[threadId] ?? EMPTY).map((m) =>
						m.id === assistantId ? { ...m, ...patch } : m,
					),
				},
			}));

		try {
			const response = await apiFetch(
				`/api/chat/threads/${threadId}/messages`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text }),
				},
			);
			const reader = response.body?.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = (await reader?.read()) ?? {
					done: true,
					value: undefined,
				};
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) {
						continue;
					}
					const event = JSON.parse(line) as {
						type: string;
						text?: string;
						message?: StoredMessage;
						part?: MessagePart;
					};
					if (event.type === "user" && event.message) {
						// 服务器确认了用户消息（真实持久化 id）——换掉本地占位
						// id，消息操作（分叉锚点等）必须用服务端 id
						set((s) => ({
							messages: {
								...s.messages,
								[threadId]: (s.messages[threadId] ?? EMPTY).map((m) =>
									m.id === userMessage.id
										? { ...event.message!, status: "complete" as const }
										: m,
								),
							},
						}));
					} else if (event.type === "delta" && event.text) {
						const current = (get().messages[threadId] ?? EMPTY).find(
							(m) => m.id === assistantId,
						);
						patchAssistant({ text: (current?.text ?? "") + event.text });
					} else if (event.type === "tool" && event.part) {
						// tool-call cards render live while the turn continues
						set((s) => ({
							messages: {
								...s.messages,
								[threadId]: (s.messages[threadId] ?? EMPTY).map((m) =>
									m.id === assistantId
										? {
												...m,
												parts: [...(m.parts ?? []), event.part as MessagePart],
											}
										: m,
								),
							},
						}));
					} else if (event.type === "done" && event.message) {
						patchAssistant({
							id: event.message.id,
							text: event.message.text,
							parts: event.message.parts,
							variants: event.message.variants,
							status: "complete",
						});
					} else if (event.type === "error") {
						patchAssistant({
							text: `${
								(get().messages[threadId] ?? EMPTY).find(
									(m) => m.id === assistantId,
								)?.text
							}\n\n⚠ ${event.text ?? "运行出错"}`,
							status: "complete",
						});
					}
				}
			}
		} finally {
			set((s) => ({
				runningThreadId:
					s.runningThreadId === threadId ? null : s.runningThreadId,
				threads: s.threads.map((t) =>
					t.id === threadId ? { ...t, status: "idle" as const } : t,
				),
			}));
			// keep the threads sidebar titles fresh (first message renames)
			const threads = await apiFetch("/api/chat/threads").then(
				(r) => r.json() as Promise<ThreadMeta[]>,
			);
			if (generation === switchGeneration) {
				set({ threads });
			}
			// 轮次边界刷新：meta + 建议 + 决策账本（TF-0095）
			await refreshThread(threadId);
		}
	},
}));

/** 拉取当前线程的 meta/messages/建议/决策账本并落地（TF-0095）。 */
async function refreshThread(threadId: string): Promise<void> {
	const data = await apiFetch(`/api/chat/threads/${threadId}`).then(
		(r) => r.json() as Promise<ThreadGetResponse>,
	);
	useChatStore.setState((s) => ({
		messages: { ...s.messages, [threadId]: data.messages },
		...(s.activeId === threadId
			? {
					suggestions: data.suggestions,
					decisionPoints: data.decisionPoints,
					readSetDiff: data.readSetDiff ?? null,
					resumeCard: data.resumeCard ?? null,
					resumeCardDismissed: Boolean(data.resumeCardDismissed),
				}
			: {}),
		threads: s.threads.map((t) =>
			t.id === threadId ? { ...t, ...data.meta } : t,
		),
	}));
}

export function useActiveMessages(): StoredMessage[] {
	return (
		useChatStore((s) => (s.activeId ? s.messages[s.activeId] : undefined)) ??
		EMPTY
	);
}
