import { randomUUID } from "node:crypto";

import type { Blackboard } from "../blackboard";

import { ChatThreads } from "../chat/threads";

import { WORKBENCH_VERSION } from "../version";

import { FALLBACK_PAGE, readUiAsset, resolveUiAssets } from "./assets";
import { chatRoute } from "./chat-routes";
import { newReconcileStats, runReconcileTick } from "./reconcile-loop";
import { collectState } from "./state";
import { tribunalRoute } from "./tribunal-routes";
import { workspaceRoute } from "./workspace-routes";

export { resolveUiAssets } from "./assets";
export { collectState } from "./state";

type UiServer = Bun.Server<undefined> & {
	authToken: string;
	handle: (request: Request) => Promise<Response>;
};

export interface UiServerOptions {
	/** Keep short timeout reproduction in tests; production retains 120s for ordinary requests. */
	idleTimeoutSeconds?: number;
	/**
	 * Background reconcile period. Tests drive the tick deterministically at a
	 * short period instead of sleeping the production 15s (TF-0260).
	 */
	reconcileIntervalMs?: number;
}

export async function createUiServer(
	bb: Blackboard,
	port: number,
	uiDirOverride?: string,
	options: UiServerOptions = {},
): Promise<UiServer> {
	const assets = await resolveUiAssets(uiDirOverride);

	const chat = new ChatThreads(bb);

	// Startup sweep: a ui process that died mid-turn leaves thread meta pinned
	// at status=running, and nothing else ever resets it (busy checks stay
	// stuck). Reconcile once on boot so a restart is the recovery path.
	await chat.reconcileRunningOnStartup();

	const token = randomUUID();

	const reconcileStats = newReconcileStats();

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);

		const local = new Set(["127.0.0.1", "localhost", "::1"]);

		if (!local.has(url.hostname)) {
			return new Response("forbidden", { status: 403 });
		}

		const unauthorized = () => new Response("unauthorized", { status: 401 });

		if (url.pathname.startsWith("/api")) {
			if (url.pathname === "/api/bootstrap" && request.method === "GET") {
				return Response.json({ token, version: WORKBENCH_VERSION });
			}
			if (request.headers.get("x-workbench-token") !== token) {
				return unauthorized();
			}
		}

		if (url.pathname === "/api/state") {
			const state = await collectState(bb);
			return Response.json({
				...state,
				reconcile: {
					failures: reconcileStats.reconcileFailures,
					lastError: reconcileStats.lastReconcileError,
					// TF-0260 (F-06): a corrupt workbench.yaml is its own identity,
					// not folded into the generic reconcile failure count.
					configLoadFailures: reconcileStats.configLoadFailures,
					lastConfigError: reconcileStats.lastConfigError,
				},
			});
		}
		const response =
			(await workspaceRoute(bb, url, request)) ??
			(await tribunalRoute(bb, url, request)) ??
			(await chatRoute(bb, chat, url, request));
		if (response) return response;
		if (!url.pathname.startsWith("/api")) {
			// static SPA with history fallback: exact asset, else index.html
			const direct =
				url.pathname === "/"
					? await readUiAsset(assets, "/")
					: await readUiAsset(assets, url.pathname);
			if (direct) {
				return direct;
			}
			const index = await readUiAsset(assets, "/");
			if (index) {
				return index;
			}
			// No asset resolved and no index to fall back on: the UI build is
			// missing or corrupt. Return a non-2xx with a machine-readable
			// marker so a health probe can tell "UI assets failed to load" from
			// "UI healthy" — a 200 shell would look identical to success
			// (TF-0257 / F-05).
			return new Response(FALLBACK_PAGE, {
				status: 503,
				headers: {
					"content-type": "text/html; charset=utf-8",
					"x-workbench-ui-assets": "missing",
				},
			});
		}

		return new Response("not found", { status: 404 });
	}

	const server = Bun.serve({
		port,
		hostname: "127.0.0.1",
		async fetch(request, server) {
			const response = await handle(request);
			// Model/tool silence is governed by the turn and process timeouts.
			// A socket idle timer must not race those and hide their terminal error.
			if (response.headers.get("content-type") === "application/x-ndjson") {
				server.timeout(request, 0);
			}
			return response;
		},
		// Ordinary requests retain a bounded idle timeout; NDJSON turns opt out above.
		idleTimeout: options.idleTimeoutSeconds ?? 120,
	});

	const RECONCILE_INTERVAL_MS = options.reconcileIntervalMs ?? 15_000;

	// TF-0260 (F-06): the tick body lives in reconcile-loop.ts so the config-read
	// failure has its own identity (counter + last error + one-shot event) instead
	// of being swallowed by `bb.config.load().catch(() => null)` here.
	const reconcileTimer = setInterval(() => {
		void runReconcileTick(bb, chat, reconcileStats);
	}, RECONCILE_INTERVAL_MS);

	const superStop = server.stop.bind(server);

	return Object.assign(server, {
		authToken: token,
		handle,
		stop: (closeActiveConnections?: boolean) => {
			clearInterval(reconcileTimer);
			return superStop(closeActiveConnections);
		},
	});
}
