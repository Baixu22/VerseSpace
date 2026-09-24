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

export {
	CODEX_COMMAND_DEFAULT,
	codexCommand,
	decideServerRequest,
	normalizeNotification,
	type ServerRequestDecision,
} from "./protocol";
export {
	type CodexAppServer,
	type CodexAppServerOptions,
	createCodexAppServer,
} from "./session";
