import type { ProcHandle } from "../../supervisor";
import { spawnSupervised } from "../../supervisor";
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
		// Server-initiated request (has id AND method) — answer per ADR-0017.
		if (message.id !== undefined && message.method) {
			answerServerRequest(message.id, message.method);
			return;
		}
		// Notification (method, no id) — normalize and forward to the router.
		if (message.method) {
			const event = normalizeNotification(message.method, message.params);
			options.onEvent(event);
			// Only `turn/completed` and a provider `error` end a turn. Notably
			// NOT `thread/compacted`: compaction happens *during* a turn, so
			// treating it as terminal would resolve early, detach the router and
			// persist a partial assistant message. (The retained fixtures only
			// carry it turn-less, which is why it read as terminal.)
			if (message.method === "turn/completed" || message.method === "error") {
				settleTurn();
			}
		}
	}

	function answerServerRequest(id: number | string, method: string): void {
		const decision = decideServerRequest(method);
		if (decision.kind === "approval") {
			// Only the reply is wired here. The read/write claim that reaches the
			// ledger is the `commandExecution` item's structured
			// `commandActions[].path` (see codex-footprint.ts); this request's own
			// params are NOT parsed, because no retained fixture documents their
			// shape. ADR-0017 records that boundary.
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
