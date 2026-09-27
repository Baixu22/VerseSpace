import type { ProcHandle } from "../../supervisor";
import { spawnSupervised } from "../../supervisor";
import { type ApprovalTargets, approvalTargets } from "./approval-targets";
import { FileChangePathIndex } from "./file-change-paths";
import {
	asRecord,
	CLIENT_INFO,
	codexCommand,
	decideServerRequest,
	type JsonRpcMessage,
	normalizeNotification,
} from "./protocol";

/**
 * A live codex app-server session. One process per thread, reused across turns
 * (like the claude session). The caller drives it with `initialize`, then
 * `startThread`, then `startTurn` per user message.
 */
export interface CodexAppServer {
	readonly proc: ProcHandle;
	/** Handshake: `initialize` request + `initialized` notification. */
	initialize(): Promise<void>;
	/** Open (or resume) a thread; resolves with the codex thread id. */
	startThread(opts: { cwd: string; resume?: string }): Promise<string>;
	/** Submit a user turn; resolves when `turn/completed` (or a terminal frame) arrives. */
	startTurn(threadId: string, text: string): Promise<void>;
	/**
	 * End the active turn with a visible error without killing the process —
	 * how a liveness verdict or a caller-side cancel reports itself. No-op when
	 * no turn is in flight.
	 */
	abortTurn(reason: string): void;
	/**
	 * Record why the caller is ending this process, so the exit reports that
	 * reason instead of a bare exit code. Used by the silence watch, whose
	 * verdict may land during the handshake — before any turn exists to report
	 * into.
	 */
	noteTermination(reason: string): void;
	/** Best-effort interrupt of the active turn, then close. */
	shutdown(): Promise<void>;
}

export interface CodexAppServerOptions {
	cwd: string;
	registryDir: string;
	label: string;
	/** One normalized, `type`-tagged codex event (fixture shape). */
	onEvent: (event: Record<string, unknown>) => void;
	/** Any line from the child (either stream) — the liveness watch's heartbeat. */
	onActivity?: () => void;
	/** Raw stderr line (diagnostics only). */
	onStderr?: (line: string) => void;
	commandLine?: string;
	/**
	 * The seal point for codex's write side (TF-0263 option A). Called for an
	 * approval request whose target paths could be attributed; returning
	 * `{ blocked: true }` turns the approval into a decline. Absent = ADR-0017's
	 * old behaviour (auto-accept), which is what a caller without a ledger wants.
	 */
	sealApproval?: (
		target: ApprovalTargets,
	) => Promise<{ blocked: boolean; reason?: string }>;
}

export function createCodexAppServer(
	options: CodexAppServerOptions,
): CodexAppServer {
	let nextRequestId = 1;
	const pending = new Map<
		string,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	let turnResolve: (() => void) | null = null;
	/** Set once the child is gone; every later request fails against it. */
	let exitReason: string | null = null;
	/** Why the caller ended it, when the caller knows (see `noteTermination`). */
	let terminationReason: string | null = null;
	/**
	 * `itemId → changes[].path` for the `fileChange` items of the current turn
	 * (TF-0263 follow-up). An approval request names the item and carries no path
	 * of its own, so this is the only way a native write becomes attributable.
	 * Turn-scoped and capped — see `file-change-paths.ts`.
	 */
	const fileChanges = new FileChangePathIndex();

	const proc = spawnSupervised(options.commandLine ?? codexCommand(), {
		label: options.label,
		registryDir: options.registryDir,
		cwd: options.cwd,
		keepStdinOpen: true,
		onLine: (line, kind) => {
			options.onActivity?.();
			if (kind === "err") {
				options.onStderr?.(line);
				return;
			}
			handleLine(line);
		},
	});

	function write(message: Record<string, unknown>): void {
		try {
			proc.writeStdin(`${JSON.stringify(message)}\n`);
		} catch (error) {
			// The child is gone. Letting this throw would escape a stream 'data'
			// handler while we are answering a server request (an uncaught
			// exception), and the exit sweep below already fails every waiter —
			// so a dropped write is accounted for, not swallowed silently.
			options.onStderr?.(`codex stdin 不可写：${String(error)}`);
		}
	}

	function sendRequest(method: string, params: unknown): Promise<unknown> {
		// A request issued after the sweep already ran would otherwise be
		// registered and never answered: the exit that would have failed it has
		// passed. Fail it here instead of leaking the promise.
		if (exitReason !== null) {
			return Promise.reject(new Error(exitReason));
		}
		const id = nextRequestId++;
		return new Promise((resolve, reject) => {
			pending.set(String(id), { resolve, reject });
			write({ id, method, params });
		});
	}

	/** Resolve the in-flight turn, if there is one. Idempotent by construction. */
	function settleTurn(): void {
		const resolve = turnResolve;
		turnResolve = null;
		resolve?.();
	}

	/**
	 * The process is the authority on liveness. Without this sweep a missing
	 * `codex` binary (spawn settles with an error) or a crash mid-turn leaves
	 * every promise unsettled: `initialize`/`thread/start` never return, the
	 * turn never resolves, and the thread's enqueue lock is held forever — the
	 * exact wedge TF-0200 fixed on the claude lane by resolving its turn from
	 * `proc.wait()`. A killed process is our own idle-close or cancel, so it is
	 * only reported when a turn was actually waiting on it.
	 */
	void proc.wait().then((outcome) => {
		exitReason =
			outcome.error !== undefined
				? `codex app-server 启动失败：${outcome.error}`
				: (terminationReason ??
					(outcome.killed
						? "codex app-server 已结束（会话被终止）"
						: `codex app-server 退出码 ${outcome.exitCode}（会话已结束）`));
		for (const waiter of pending.values()) {
			waiter.reject(new Error(exitReason));
		}
		pending.clear();
		if (turnResolve) {
			options.onEvent({ type: "error", error: { message: exitReason } });
			settleTurn();
		}
	});

	function handleLine(line: string): void {
		if (!line.trim()) return;
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(line) as JsonRpcMessage;
		} catch {
			return;
		}
		// Response to one of our requests (has id, no method).
		if (message.id !== undefined && message.method === undefined) {
			const waiter = pending.get(String(message.id));
			if (waiter) {
				pending.delete(String(message.id));
				if (message.error) {
					waiter.reject(
						new Error(message.error.message ?? "codex request failed"),
					);
				} else {
					waiter.resolve(message.result);
				}
			}
			return;
		}
		// Server-initiated request (has id AND method) — answer per ADR-0017, with
		// the seal consulted for write approvals (TF-0263 option A). Consulting the
		// seal is a ledger read, so this is async; the server must never be left
		// waiting, hence the catch still answers with the policy default.
		if (message.id !== undefined && message.method) {
			const id = message.id;
			const method = message.method;
			void answerServerRequest(id, method, message.params).catch(
				(error: unknown) => {
					options.onStderr?.(
						`[codex] 审批应答失败，按默认放行：${(error as Error).message}`,
					);
					write({ id, result: { decision: "accept" } });
				},
			);
			return;
		}
		// Notification (method, no id) — normalize and forward to the router.
		if (message.method) {
			const event = normalizeNotification(message.method, message.params);
			// A native write announces its target here, on the item — not on the
			// approval that follows it. Record it before the router sees the line,
			// so the very next approval can resolve its `params.itemId`.
			fileChanges.note(event);
			options.onEvent(event);
			// Only `turn/completed` and a provider `error` end a turn. Notably
			// NOT `thread/compacted`: compaction happens *during* a turn, so
			// treating it as terminal would resolve early, detach the router and
			// persist a partial assistant message. (The retained fixtures only
			// carry it turn-less, which is why it read as terminal.)
			if (message.method === "turn/completed" || message.method === "error") {
				// The turn is over; its write items can no longer be approved.
				fileChanges.clear();
				settleTurn();
			}
		}
	}

	async function answerServerRequest(
		id: number | string,
		method: string,
		params: unknown,
	): Promise<void> {
		const decision = decideServerRequest(method);
		if (decision.kind === "approval") {
			// TF-0263 option A: the codex write side now goes through the seal.
			// ADR-0017 used to auto-accept here, which left a write onto a stale
			// premise unblocked (measured 2026-09-26: the write landed with zero
			// `seal.decided` events).
			//
			// Only *attributable* requests can be sealed. A write whose target we
			// cannot read out of the params is NOT silently treated as guarded — it
			// is reported as unattributable, because silence is never a decision.
			//
			// A `fileChange` approval is attributable only through correlation: its
			// params name an item and carry no path (fixture:
			// src/chat/fixtures/approvals/file-change-0.158.json), so the paths come
			// from the item the stream already reported under that same id.
			const target = approvalTargets(
				method,
				params,
				fileChanges.pathsFor(asRecord(params)?.itemId),
			);
			if (
				options.sealApproval &&
				target.kind === "write" &&
				target.paths.length > 0
			) {
				try {
					const sealed = await options.sealApproval(target);
					if (sealed.blocked) {
						// The decision itself is already in events.jsonl: decideSeal
						// records every verdict, including this one.
						//
						// `cancel`, not `decline`: the real 0.158 params carry
						// `availableDecisions: ["accept", {acceptWithExecpolicyAmendment},
						// "cancel"]` — there is no "decline" to send (fixture:
						// src/chat/fixtures/approvals/command-execution-0.158.json).
						write({ id, result: { decision: "cancel" } });
						return;
					}
				} catch (error) {
					// A seal that cannot decide must not wedge the turn. Fail open,
					// and say so out loud.
					options.onStderr?.(
						`[codex] 封印判定失败，按放行处理：${(error as Error).message}`,
					);
				}
			} else if (options.sealApproval && target.kind !== "read") {
				// An approval the seal did not decide must say so. `write` with no
				// path is the unattributable-write case; `unknown` is a command codex
				// itself could not classify (all 5 approvals of the real 0.158 write
				// turn were `[{type:"unknown"}]` around a shell `apply_patch`), so it
				// may or may not write — either way the seal was not consulted. The
				// real 0.158 write approvals printed nothing at all before this.
				options.onStderr?.(
					target.kind === "write"
						? "[codex] 写审批无法归因到路径，未咨询封印（记录为不可归因）"
						: "[codex] 审批无法判定读/写，未咨询封印（记录为不可归因）",
				);
			}
			// Only the reply is wired here. The read/write claim that reaches the
			// ledger is the `commandExecution` item's structured
			// `commandActions[].path` (see codex-footprint.ts).
			write({ id, result: { decision: decision.decision } });
		} else if (decision.kind === "userInput") {
			// Decline shape per MCP elicitation / codex requestUserInput.
			write({ id, result: { action: "decline" } });
		} else {
			// Not a ledger decision — but the server is waiting on a reply, so
			// silence would block it. Answer with an empty result and move on.
			write({ id, result: {} });
		}
	}

	return {
		proc,
		abortTurn(reason) {
			if (!turnResolve) return;
			options.onEvent({ type: "error", error: { message: reason } });
			settleTurn();
		},
		noteTermination(reason) {
			terminationReason = reason;
		},
		async initialize() {
			await sendRequest("initialize", CLIENT_INFO);
			write({ method: "initialized" });
		},
		async startThread({ cwd, resume }) {
			const method = resume ? "thread/resume" : "thread/start";
			const params: Record<string, unknown> = { cwd };
			if (resume) params.threadId = resume;
			const response = await sendRequest(method, params);
			const thread = asRecord(asRecord(response)?.thread);
			const id = thread?.id;
			return typeof id === "string" ? id : (resume ?? "");
		},
		startTurn(threadId, text) {
			return new Promise<void>((resolve) => {
				turnResolve = resolve;
				void sendRequest("turn/start", {
					threadId,
					input: [{ type: "text", text, text_elements: [] }],
				}).catch((error) => {
					options.onEvent({
						type: "error",
						error: { message: String(error) },
					});
					settleTurn();
				});
			});
		},
		async shutdown() {
			await proc.kill().catch(() => {});
			for (const waiter of pending.values()) {
				waiter.reject(new Error("codex app-server closed"));
			}
			pending.clear();
		},
	};
}
