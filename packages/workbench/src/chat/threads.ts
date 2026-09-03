import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Blackboard } from "../blackboard";
import {
	extractFootprint,
	hashPathClaim,
	type ParsedStreamFootprint,
} from "../blackboard/footprint";
import { type ProcHandle, spawnSupervised } from "../supervisor";
import type { WorkbenchConfig } from "../types/config";
import { buildVariants, clampFanout } from "./fanout";
import {
	buildForkDeclaration,
	type ForkLineage,
	type ForkOutcome,
	forkSlice,
} from "./fork";
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
	emit: (event: RunEvent) => void;
	resolve: () => void;
}

/** A persistent claude child process owned by one thread. */
interface LiveClaudeSession {
	proc: ProcHandle;
	claudeSessionId: string | undefined;
	turn: ActiveTurn | null;
	idleTimer?: ReturnType<typeof setTimeout>;
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

	constructor(private bb: Blackboard) {}

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
			const note = buildResumeNote(messages, meta, now);
			if (!note) {
				return null;
			}
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
			if (
				this.running.get(id) instanceof AbortController ||
				this.live.get(id)?.turn
			) {
				return { ok: false, reason: "线程正在运行" };
			}
			const source = await this.get(id);
			const sliced = forkSlice(await this.messages(id), anchorMessageId);
			if (!sliced.ok) {
				return { ok: false, reason: "找不到锚点消息" };
			}
			const { inherited, anchor } = sliced;

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

			return {
				ok: true,
				thread: forkMeta,
				declaration: buildForkDeclaration(anchor, inherited.length),
			};
		});
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
			if (
				this.running.get(id) instanceof AbortController ||
				this.live.get(id)?.turn
			) {
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

			if (chat.provider === "claude") {
				// notices queued while the thread was idle are delivered as
				// context turns BEFORE the user's message (KV-cache safe: the
				// session only ever appends)
				const notices = await this.drainNotices(id);
				await this.runClaudeTurn(id, meta, text, emit, {
					resend: Boolean(opts.resend),
					precedingNotices: notices,
				});
				return;
			}

			// ── HTTP providers: OpenAI Chat Completions / Responses, Anthropic ──
			const controller = new AbortController();
			this.running.set(id, controller);
			const messageParts: MessagePart[] = [];
			try {
				await this.runHttp(chat, id, emit, messageParts, controller.signal);
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
		return JSON.stringify({
			type: "user",
			message: { role: "user", content: text },
		});
	}

	private async runClaudeTurn(
		id: string,
		meta: ThreadMeta,
		text: string,
		emit: (event: RunEvent) => void,
		opts: { resend: boolean; precedingNotices: string[] },
	): Promise<void> {
		const userTurn = this.turnLine(text);
		const noticeTurns = opts.precedingNotices.map((n) => this.turnLine(n));
		let live = this.live.get(id);
		if (!live) {
			live = await this.ensureClaudeSession(id, meta, [
				...noticeTurns,
				userTurn,
			]);
		} else {
			// deliver queued notices first, then the user's turn
			for (const line of noticeTurns) {
				live.proc.writeStdin(line);
				emit({ type: "notice_delivered" });
			}
			live.proc.writeStdin(userTurn);
		}
		const session = live;
		if (session.idleTimer) {
			clearTimeout(session.idleTimer);
			session.idleTimer = undefined;
		}

		// per-turn state; the session-level line router fills it
		let resolveTurn!: () => void;
		const turn: ActiveTurn = {
			assistantTexts: [],
			messageParts: [],
			stderr: "",
			pendingFootprints: new Map(),
			fpQueue: Promise.resolve(),
			sawInit: false,
			finished: false,
			emit,
			resolve: () => {
				if (!turn.finished) {
					turn.finished = true;
					resolveTurn();
				}
			},
		};
		session.turn = turn;

		// the turn ends when the CLI reports this turn's result (or the
		// session dies) — the child itself stays alive for the next turn
		await new Promise<void>((resolve) => {
			resolveTurn = resolve;
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
		});

		// finalize the turn: footprints, messages, meta
		// the child stays alive between turns, but the turn is over — detach
		// it so session-level noise stops being routed and reload/fork see an
		// idle thread (SESSION_IDLE_CLOSE_MS keeps the child for minutes)
		session.turn = null;
		await turn.fpQueue;
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
		let commandLine = chatCommand();
		if (meta.permissionMode !== "default") {
			commandLine += ` --permission-mode ${meta.permissionMode}`;
		}
		// streaming input keeps the session alive across turns; the first
		// turn mints the session id (--session-id), respawns resume it
		commandLine += " --input-format stream-json";
		if (claudeSessionId) {
			commandLine += meta.hasResumableSession
				? ` --resume ${claudeSessionId}`
				: ` --session-id ${claudeSessionId}`;
		}

		const proc = spawnSupervised(commandLine, {
			label: `chat:${id}`,
			registryDir: join(this.bb.paths.root, "proc"),
			cwd: this.bb.projectRoot,
			stdin: firstTurnLines.join("\n"),
			keepStdinOpen: true,
			stdinGate: (line) => line.includes('"subtype":"init"'),
			onLine: (line, kind) => {
				if (kind === "out") {
					this.lineRouters.get(id)?.(line);
				} else {
					const turn = this.live.get(id)?.turn;
					if (turn) {
						turn.stderr += `${line}\n`;
					}
				}
			},
		});
		this.running.set(id, proc);
		const session: LiveClaudeSession = { proc, claudeSessionId, turn: null };
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
				return; // no turn in flight: session-level noise
			}
			if (event.type === "system" && event.subtype === "init") {
				turn.sawInit = true;
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
						const fp = extractFootprint(event, id);
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
											join(this.bb.paths.root, "sessions", id, "spool"),
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
				const result =
					typeof event.result === "string" ? event.result : undefined;
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
	 * R2: deliver a premise-invalidation notice into a writer's session.
	 * Live session → injected as a user turn between turns (KV-cache safe:
	 * append-only). Idle thread → queued; delivered before its next turn.
	 */
	async notifySession(
		writerId: string,
		notice: string,
	): Promise<"delivered" | "queued"> {
		const session = this.live.get(writerId);
		if (session) {
			try {
				session.proc.writeStdin(this.turnLine(notice));
				await this.bb.events.append({
					timestamp: new Date().toISOString(),
					source: "runtime",
					type: "premise_notice_delivered",
					payload: { writer: writerId, via: "live-session" },
				});
				return "delivered";
			} catch {
				// stdin already closed — fall through to the queue
			}
		}
		const { appendFile, mkdir } = await import("node:fs/promises");
		await mkdir(this.dir(writerId), { recursive: true });
		await appendFile(
			this.noticesFile(writerId),
			`${JSON.stringify({ notice, at: new Date().toISOString() })}\n`,
			"utf8",
		);
		return "queued";
	}

	private noticesFile(id: string): string {
		return join(this.dir(id), "notices.jsonl");
	}

	/** Drain and clear queued notices (called at the start of a run). */
	private async drainNotices(id: string): Promise<string[]> {
		try {
			const { readFile, rm } = await import("node:fs/promises");
			const raw = await readFile(this.noticesFile(id), "utf8");
			await rm(this.noticesFile(id), { force: true });
			return raw
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => {
					try {
						return (JSON.parse(line) as { notice: string }).notice;
					} catch {
						return line;
					}
				})
				.filter((notice) => notice.trim().length > 0);
		} catch {
			return [];
		}
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
	): Promise<void> {
		const provider = chat.provider;
		const key = chat.apiKey ?? "";
		if (!key && provider !== "claude") {
			emit({
				type: "error",
				message: "未配置 API Key——在 设置 中填写后重试",
			});
			return;
		}

		const history = await this.history(id);
		const fanout = clampFanout(chat.fanout);
		const { url, headers, body } = this.buildHttpRequest(
			provider,
			key,
			chat,
			history,
		);

		const onSseData = (payload: string) => {
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
					const d = event.delta as { type?: string; text?: string } | undefined;
					if (d?.type === "text_delta" && d.text) {
						delta = d.text;
					}
				} else if (event.type === "error") {
					const err = event.error as { message?: string } | undefined;
					emit({
						type: "error",
						message: err?.message ?? "anthropic stream error",
					});
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
				} else if (event.type === "error") {
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

		await this.consumeSse(response, onSseData);
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
			url = `${(chat.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "")}/v1/messages`;
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
			url = `${(chat.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/chat/completions`;
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
			url = `${(chat.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`;
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
	): Promise<void> {
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			const chunks = buffer.split("\n\n");
			buffer = chunks.pop() ?? "";
			for (const chunk of chunks) {
				for (const line of chunk.split("\n")) {
					if (line.startsWith("data:")) {
						onSseData(line.slice(5).trim());
					}
				}
			}
		}
	}
}
