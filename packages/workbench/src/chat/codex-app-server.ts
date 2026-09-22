import type { ProcHandle } from "../supervisor";
import { spawnSupervised } from "../supervisor";

/**
 * Codex `app-server` transport (TF-0249 / ADR-0017).
 *
 * The codex CLI's `app-server` subcommand speaks a JSON-RPC-style protocol over
 * stdio (newline-delimited JSON, `jsonrpc` version field omitted). This module
 * is the thin driver: spawn the CLI under `spawnSupervised` (same process
 * supervision as the claude lane — no sidecar), run the `initialize` handshake,
 * open a thread, submit turns, and normalize every server notification into the
 * `type`-tagged shape the retained fixtures use, so the render reducer and the
 * fixture gate face the identical input.
 *
 * What this module deliberately does NOT do: parse or render. It emits raw
 * normalized lines through `onEvent`; `codex-router.ts` owns the render
 * decision and footprint side effects, exactly as `claude-router.ts` does for
 * the claude lane.
 */

export const CODEX_COMMAND_DEFAULT = "codex app-server -c notify=[]";

export const codexCommand = (): string =>
	process.env.WORKBENCH_CODEX_COMMAND ?? CODEX_COMMAND_DEFAULT;

/** Client identity sent in the `initialize` handshake (mirrors the retired sidecar). */
const CLIENT_INFO = {
	clientInfo: { name: "workbench", title: "Workbench", version: "0.1.0" },
	capabilities: { experimentalApi: true },
} as const;

/** How a server-initiated request should be answered (ADR-0017 interaction table). */
export type ServerRequestDecision =
	| { kind: "approval"; decision: "accept" | "decline" }
	| { kind: "userInput"; action: "decline" }
	| { kind: "ignore" };

const APPROVAL_METHODS = new Set([
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"item/fileRead/requestApproval",
]);
const USER_INPUT_METHODS = new Set([
	"item/tool/requestUserInput",
	"mcpServer/elicitation/request",
]);

/**
 * ADR-0017: permission requests are auto-accepted (seal is the one interception
 * point, not a per-tool gate) — the read/write target still lands in the ledger.
 * User-input requests are auto-declined so the turn cannot wedge. Anything else
 * is ignored.
 */
export function decideServerRequest(method: string): ServerRequestDecision {
	if (APPROVAL_METHODS.has(method)) {
		return { kind: "approval", decision: "accept" };
	}
	if (USER_INPUT_METHODS.has(method)) {
		return { kind: "userInput", action: "decline" };
	}
	return { kind: "ignore" };
}

interface JsonRpcMessage {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message?: string };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

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
	/** Best-effort interrupt of the active turn, then close. */
	shutdown(): Promise<void>;
}

export interface CodexAppServerOptions {
	cwd: string;
	registryDir: string;
	label: string;
	/** One normalized, `type`-tagged codex event (fixture shape). */
	onEvent: (event: Record<string, unknown>) => void;
	/** Raw stderr line (diagnostics only). */
	onStderr?: (line: string) => void;
	commandLine?: string;
}

/**
 * Normalize a server notification into the fixture's `type`-tagged shape.
 * The app-server notification already carries `{ method, params }`; the retained
 * fixtures flattened `params` up under a `type` = method. We reproduce that so
 * the reducer sees one shape whether it is fed a fixture or a live line.
 */
export function normalizeNotification(
	method: string,
	params: unknown,
): Record<string, unknown> {
	const base = asRecord(params) ?? {};
	return { type: method, ...base };
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

	const proc = spawnSupervised(options.commandLine ?? codexCommand(), {
		label: options.label,
		registryDir: options.registryDir,
		cwd: options.cwd,
		keepStdinOpen: true,
		onLine: (line, kind) => {
			if (kind === "err") {
				options.onStderr?.(line);
				return;
			}
			handleLine(line);
		},
	});

	function write(message: Record<string, unknown>): void {
		proc.writeStdin(`${JSON.stringify(message)}\n`);
	}

	function sendRequest(method: string, params: unknown): Promise<unknown> {
		const id = nextRequestId++;
		return new Promise((resolve, reject) => {
			pending.set(String(id), { resolve, reject });
			write({ id, method, params });
		});
	}

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
			if (message.method === "turn/completed" || message.method === "error") {
				turnResolve?.();
				turnResolve = null;
			}
			if (message.method === "thread/compacted") {
				turnResolve?.();
				turnResolve = null;
			}
		}
	}

	function answerServerRequest(id: number | string, method: string): void {
		const decision = decideServerRequest(method);
		if (decision.kind === "approval") {
			write({ id, result: { decision: decision.decision } });
		} else if (decision.kind === "userInput") {
			// Decline shape per MCP elicitation / codex requestUserInput.
			write({ id, result: { action: "decline" } });
		} else {
			write({ id, result: {} });
		}
	}

	return {
		proc,
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
					turnResolve?.();
					turnResolve = null;
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
