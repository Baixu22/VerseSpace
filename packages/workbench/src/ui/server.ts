import { randomUUID } from "node:crypto";

import type { Blackboard } from "../blackboard";

import { ChatThreads } from "../chat/threads";

import { drainPremiseQueue } from "../runtime/delivery";
import { reconcilePremises } from "../runtime/premises";

import { WORKBENCH_VERSION } from "../version";

import { FALLBACK_PAGE, readUiAsset, resolveUiAssets } from "./assets";
import { chatRoute } from "./chat-routes";
import { collectState } from "./state";
import { tribunalRoute } from "./tribunal-routes";
import { workspaceRoute } from "./workspace-routes";

export { resolveUiAssets } from "./assets";
export { collectState } from "./state";

type UiServer = Bun.Server<undefined> & {
	authToken: string;
	handle: (request: Request) => Promise<Response>;
};
export async function createUiServer(
	bb: Blackboard,
	port: number,
	uiDirOverride?: string,
): Promise<UiServer> {
	const assets = await resolveUiAssets(uiDirOverride);

	const chat = new ChatThreads(bb);

	// Startup sweep: a ui process that died mid-turn leaves thread meta pinned
	// at status=running, and nothing else ever resets it (busy checks stay
	// stuck). Reconcile once on boot so a restart is the recovery path.
	await chat.reconcileRunningOnStartup();

	const token = randomUUID();

	let reconcileFailures = 0;

	let lastReconcileError: string | null = null;

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
					failures: reconcileFailures,
					lastError: lastReconcileError,
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
			return new Response(FALLBACK_PAGE, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}

		return new Response("not found", { status: 404 });
	}

	const server = Bun.serve({
		port,
		hostname: "127.0.0.1",
		fetch: handle,
		// Bun's default 10s idle timeout kills slow-starting LLM streams: a
		// free-tier model can think for well over 10s before the first SSE
		// byte, and the NDJSON chat route dies mid-turn (E2E round 6, found
		// 2026-09-06). Streaming responses reset the timer on every chunk.
		idleTimeout: 120,
	});

	const RECONCILE_INTERVAL_MS = 15_000;

	const reconcileTimer = setInterval(() => {
		void (async () => {
			try {
				await reconcilePremises(bb);
			} catch (err) {
				reconcileFailures++;
				lastReconcileError = err instanceof Error ? err.message : String(err);
				console.error(
					`[workbench-ui] reconcilePremises failed (#${reconcileFailures}):`,
					err,
				);
			}
			const config = await bb.config.load().catch(() => null);
			try {
				await drainPremiseQueue(bb, {
					tokenBudget: config?.chat.noticeTokenBudget,
					deliver: (writerId, message, noticeId) =>
						chat.notifySession(writerId, message, noticeId),
				});
			} catch (err) {
				reconcileFailures++;
				lastReconcileError = err instanceof Error ? err.message : String(err);
				console.error(
					`[workbench-ui] drainPremiseQueue failed (#${reconcileFailures}):`,
					err,
				);
			}
		})();
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
