export const CODEX_COMMAND_DEFAULT = "codex app-server -c notify=[]";

export const codexCommand = (): string =>
	process.env.WORKBENCH_CODEX_COMMAND ?? CODEX_COMMAND_DEFAULT;

/** Client identity sent in the `initialize` handshake (mirrors the retired sidecar). */
export const CLIENT_INFO = {
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
 * Default reply policy. session.ts consults sealApproval for attributable write
 * approvals before using this default. It is experimental: missing approvals,
 * unobserved reads and unattributable targets are not protected (ADR-0023).
 * User-input requests are declined so a turn cannot wedge.
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

export interface JsonRpcMessage {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message?: string };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
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
	// `type` last: a `type` key inside the params must not override the
	// method-derived event type the reducer dispatches on.
	return { ...base, type: method };
}
