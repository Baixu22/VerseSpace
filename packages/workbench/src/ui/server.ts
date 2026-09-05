import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Blackboard } from "../blackboard";
import { collectDecisionPoints } from "../chat/ledger";
import { buildResumeCard, isResumeCardDismissed } from "../chat/resume-card";
import { suggestNext } from "../chat/suggest";
import { ChatThreads } from "../chat/threads";
import { runDoctor } from "../doctor";
import { drainPremiseQueue } from "../runtime/delivery";
import { reconcilePremises } from "../runtime/premises";
import { diffReadSet } from "../runtime/read-set-diff";
import { workbenchConfigSchema } from "../types/config";
import { WORKBENCH_VERSION } from "../version";

export interface UiState {
	version: string;
	project: string;
	config: unknown;
	goals: unknown[];
	queue: string[];
	workspots: unknown[];
	checkpoints: {
		staging: unknown[];
		verified: unknown[];
		failed: unknown[];
	};
	/** checkpoint id → owning workspot, for lane grouping. */
	checkpointsByWorkspot: Record<string, unknown[]>;
	/** Per-workspot recent activity (newest first), the lane feed. */
	activity: Record<string, unknown[]>;
	/** Latest agent batch session per workspot, with human-readable tail. */
	agentSessions: Record<
		string,
		{ session: unknown; lastLines: string[] } | null
	>;
	interfaces: unknown[];
	decisions: unknown[];
	events: unknown[];
	doctor: { ok: boolean; issues: unknown[] };
}

/** Everything the dashboard renders, in one read of the blackboard. */
export async function collectState(bb: Blackboard): Promise<UiState> {
	const [
		config,
		goals,
		queue,
		workspots,
		checkpoints,
		interfaces,
		decisions,
		events,
		doctor,
	] = await Promise.all([
		bb.config.load(),
		bb.goals.list(),
		bb.state.queue.get(),
		bb.state.workspots.list(),
		bb.checkpoints.scanAll(),
		bb.interfaces.list(),
		bb.decisions.list(),
		bb.events.tail(200),
		runDoctor(bb),
	]);

	// map every checkpoint to its workspot so lane cards can show their own
	// checkpoints, and route checkpoint events into the right lane
	const cpOwner = new Map<string, string>();
	const checkpointsByWorkspot: Record<string, unknown[]> = {};
	for (const cp of [
		...checkpoints.staging,
		...checkpoints.verified,
		...checkpoints.failed,
	]) {
		cpOwner.set(cp.id, cp.workspot);
		const owned = checkpointsByWorkspot[cp.workspot] ?? [];
		owned.push(cp);
		checkpointsByWorkspot[cp.workspot] = owned;
	}

	const activity: Record<string, unknown[]> = {};
	const laneOf = (event: { type: string; payload: unknown }): string | null => {
		const payload = event.payload as Record<string, unknown> | null;
		if (payload && typeof payload.workspotId === "string") {
			return payload.workspotId;
		}
		if (payload && typeof payload.cpId === "string") {
			return cpOwner.get(payload.cpId) ?? null;
		}
		return null;
	};
	for (const event of events) {
		const lane = laneOf(event);
		if (lane) {
			const feed = activity[lane] ?? [];
			feed.push(event);
			activity[lane] = feed;
		}
	}
	for (const list of Object.values(activity)) {
		list.reverse(); // newest first per lane
	}

	const { readAgentView } = await import("../agents/runner");
	const agentSessions: Record<
		string,
		{ session: unknown; lastLines: string[] } | null
	> = {};
	for (const workspot of workspots) {
		agentSessions[workspot.id] = await readAgentView(bb, workspot.id);
	}

	return {
		version: WORKBENCH_VERSION,
		project: bb.projectRoot,
		config,
		goals,
		queue,
		workspots,
		checkpoints,
		checkpointsByWorkspot,
		activity,
		agentSessions,
		interfaces,
		decisions,
		events: events.reverse(),
		doctor,
	};
}

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".map": "application/json",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

function mimeFor(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot < 0
		? "application/octet-stream"
		: (MIME[path.slice(dot)] ?? "application/octet-stream");
}

const FALLBACK_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Workbench</title>
<body style="font-family:system-ui;background:#0e1116;color:#e6e8eb;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center"><h1>Workbench</h1>
<p>UI 资源未找到：先构建 <code>apps/workbench-ui</code>（<code>build:all</code> 会自动构建），
或用 <code>workbench ui --ui-dir &lt;path&gt;</code> 指定前端产物目录。</p>
<p>API：<a style="color:#4c8dff" href="/api/state">/api/state</a></p></div></body></html>`;

export interface UiAssets {
	/** Serve mode: embedded (compiled binary) wins, then disk dir. */
	kind: "embedded" | "disk" | "none";
	diskDir?: string;
	embeddedFiles?: Record<string, string>;
}

/**
 * The manifest is generated at build time with `with { type: "file" }`
 * imports of the UI dist. Loaded dynamically + fault-tolerant: a stale
 * manifest (UI rebuilt → hashed filenames changed) or a missing one degrades
 * to non-embedded modes instead of crashing the process or the tests.
 */
async function loadEmbeddedFiles(): Promise<Record<string, string>> {
	try {
		const mod = (await import("./assets.generated.js")) as {
			files: Record<string, string>;
		};
		return mod.files ?? {};
	} catch {
		return {};
	}
}

/**
 * Resolution order: explicit --ui-dir > embedded assets (compiled binary) >
 * the repo dev build (apps/workbench-ui/dist) > none (fallback page).
 */
export async function resolveUiAssets(
	uiDirOverride?: string,
): Promise<UiAssets> {
	if (uiDirOverride) {
		return { kind: "disk", diskDir: resolve(uiDirOverride) };
	}
	const embeddedFiles = await loadEmbeddedFiles();
	if (Object.keys(embeddedFiles).length > 0) {
		return { kind: "embedded", embeddedFiles };
	}
	const devDist = resolve(import.meta.dir, "../../../apps/workbench-ui/dist");
	if (existsSync(join(devDist, "index.html"))) {
		return { kind: "disk", diskDir: devDist };
	}
	return { kind: "none" };
}

function assetResponse(body: ReadableStream | string, path: string): Response {
	return new Response(body, { headers: { "content-type": mimeFor(path) } });
}

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
	// Per-run token: a fresh random secret every server start. Every /api route
	// except the /api/bootstrap handshake requires it, so a cross-site page in
	// the user's browser cannot fire state-changing requests (no CORS headers
	// are emitted at all — the SPA is same-origin; `vite dev` talks through its
	// own proxy). The handshake is safe to serve unauthenticated because its
	// response is unreadable cross-origin (SOP) and DNS rebinding is killed by
	// the host check below — a rebound page shows up with a foreign hostname.
	const token = randomUUID();

	async function readAsset(urlPath: string): Promise<Response | null> {
		const key = urlPath.replace(/^\/+/, "") || "index.html";
		if (assets.kind === "embedded" && assets.embeddedFiles) {
			const embedded = assets.embeddedFiles[key];
			if (!embedded) {
				return null;
			}
			return assetResponse(Bun.file(embedded).stream(), embedded);
		}
		if (assets.kind === "disk" && assets.diskDir) {
			const target = resolve(join(assets.diskDir, key));
			if (!target.startsWith(resolve(assets.diskDir) + sep)) {
				return null; // traversal guard
			}
			try {
				await stat(target);
			} catch {
				return null;
			}
			return assetResponse(Bun.file(target).stream(), target);
		}
		return null;
	}

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		// Anti DNS-rebinding + anti cross-site pivot: only loopback hostnames.
		// Port-agnostic so `vite dev` (127.0.0.1:5188 → proxy) keeps working.
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
			return Response.json(await collectState(bb));
		}
		if (url.pathname === "/api/sync" && request.method === "POST") {
			const { runOnce } = await import("../runtime");
			const result = await runOnce(bb);
			// the watcher or a manual sync holds the run lock: refuse instead
			// of racing — the UI can retry on the next interaction
			return Response.json(result, { status: result.busy ? 409 : 200 });
		}
		if (url.pathname === "/api/dispatch" && request.method === "POST") {
			const { dispatchGoal } = await import("../scheduler/dispatch");
			const body = (await request.json()) as {
				goalId?: string;
				workspotId?: string;
				force?: boolean;
			};
			if (!body.goalId) {
				return Response.json(
					{ ok: false, reason: "缺少 goalId" },
					{ status: 400 },
				);
			}
			const result = await dispatchGoal(bb, body.goalId, body.workspotId, {
				force: body.force === true,
			});
			return Response.json(result, { status: result.ok ? 200 : 409 });
		}
		// R3: the three views that make the machine's own numbers visible —
		// the queue (what wants a decision), WIP (what the flow allows), and
		// per-lane usage (what each lane is burning).
		if (url.pathname === "/api/tribunal" && request.method === "GET") {
			const [{ renderCard }, wip] = await Promise.all([
				import("../commands/tribunal"),
				import("../scheduler/wip").then((m) => m.observeFlow(bb)),
			]);
			const [items, stats, distribution] = await Promise.all([
				bb.tribunal.list(),
				bb.tribunal.stats(),
				bb.tribunal.distribution(),
			]);
			return Response.json({
				items: items.map((item) => ({ ...item, card: renderCard(item) })),
				stats,
				distribution,
				wip,
			});
		}
		const tribunalItem = url.pathname.match(/^\/api\/tribunal\/([^/]+)$/);
		if (tribunalItem && request.method === "POST") {
			const id = decodeURIComponent(tribunalItem[1] ?? "");
			const body = (await request.json().catch(() => ({}))) as {
				action?: string;
				minutes?: number;
			};
			const item =
				body.action === "shelve"
					? await bb.tribunal.shelve(id, body.minutes ?? 30)
					: body.action === "resolve"
						? await bb.tribunal.resolve(id)
						: null;
			if (!item) {
				return Response.json(
					{ ok: false, reason: "未知动作或条目不存在" },
					{ status: 400 },
				);
			}
			return Response.json({ ok: true, item });
		}
		if (url.pathname === "/api/wip" && request.method === "GET") {
			const { explainWip, observeFlow } = await import("../scheduler/wip");
			const flow = await observeFlow(bb);
			return Response.json({ ...flow, explanation: explainWip(flow) });
		}
		if (url.pathname === "/api/metrics" && request.method === "GET") {
			const { observeFlow } = await import("../scheduler/wip");
			const [lanes, flow] = await Promise.all([
				bb.metrics.list(),
				observeFlow(bb),
			]);
			return Response.json({
				lanes,
				unreviewedBacklog: flow.unreviewedBacklog,
			});
		}
		if (url.pathname === "/api/agent/run" && request.method === "POST") {
			const { startAgent } = await import("../agents/runner");
			const body = (await request.json()) as {
				workspotId?: string;
				prompt?: string;
			};
			if (!body.workspotId || !body.prompt) {
				return Response.json(
					{ ok: false, reason: "缺少 workspotId / prompt" },
					{ status: 400 },
				);
			}
			const result = await startAgent(bb, {
				workspotId: body.workspotId,
				prompt: body.prompt,
			});
			return Response.json(result, { status: result.ok ? 200 : 409 });
		}
		if (url.pathname === "/api/review" && request.method === "POST") {
			const { reviewCheckpoint } = await import("../runtime/review");
			const body = (await request.json()) as {
				cpId?: string;
				approve?: boolean;
			};
			if (!body.cpId || typeof body.approve !== "boolean") {
				return Response.json(
					{ ok: false, reason: "缺少 cpId / approve" },
					{ status: 400 },
				);
			}
			return Response.json(await reviewCheckpoint(bb, body.cpId, body.approve));
		}

		if (url.pathname === "/api/chat/feedback" && request.method === "POST") {
			const body = (await request.json()) as {
				threadId?: string;
				messageId?: string;
				kind?: string;
			};
			await bb.events.append({
				timestamp: new Date().toISOString(),
				source: "human",
				type: "feedback",
				payload: body,
			});
			return Response.json({ ok: true });
		}
		if (url.pathname === "/api/config/chat" && request.method === "GET") {
			const config = await bb.config.load();
			const { apiKey, ...rest } = config.chat;
			return Response.json({ ...rest, hasKey: Boolean(apiKey) });
		}
		if (url.pathname === "/api/config/chat" && request.method === "PATCH") {
			const body = (await request.json()) as Record<string, unknown>;
			const config = await bb.config.load();
			const next = { ...config.chat, ...body };
			if (body.apiKey === "") {
				next.apiKey = undefined; // empty string clears the key
			}
			config.chat = workbenchConfigSchema.parse({
				...config,
				chat: next,
			}).chat;
			await bb.config.save(config);
			const { apiKey, ...rest } = config.chat;
			return Response.json({ ...rest, hasKey: Boolean(apiKey) });
		}

		// ── chat runtime: threads + streaming messages ──
		if (url.pathname === "/api/chat/threads" && request.method === "GET") {
			return Response.json(await chat.list());
		}
		if (url.pathname === "/api/chat/threads" && request.method === "POST") {
			const body = (await request.json().catch(() => ({}))) as {
				title?: string;
			};
			return Response.json(await chat.create(body.title));
		}
		const chatMatch = url.pathname.match(
			/^\/api\/chat\/threads\/([^/]+)(\/(messages|cancel|reload|promote|fork|leave|switch|restore|resume-note(?:\/consume|\/dismiss)?|resume-action))?$/,
		);
		if (chatMatch) {
			const threadId = decodeURIComponent(chatMatch[1] ?? "");
			const sub = chatMatch[3];
			if (!sub && request.method === "GET") {
				const [meta, messages] = await Promise.all([
					chat.get(threadId),
					chat.messages(threadId),
				]);
				const readSetDiff = await diffReadSet(
					bb,
					threadId,
					meta.resumeNote?.leaveSignature,
				);
				const threadEvents = await bb.events.query({ source: "threads" });
				const resumeCardDismissed = isResumeCardDismissed(
					threadEvents,
					threadId,
					meta.resumeNote?.leaveSignature.eventId,
				);
				const resumeCard = buildResumeCard({
					note: meta.resumeNote ?? null,
					diff: readSetDiff,
					dismissed: resumeCardDismissed,
				});
				// TF-0095：建议与决策账本由同一组纯函数在服务端推导，
				// UI 是纯渲染层——无分歧时账本为空数组（完全不渲染）
				// TF-0097：resumeNote 随 meta 持久化，离开时生成、返回时呈现
				return Response.json({
					meta,
					messages,
					suggestions: suggestNext(messages),
					decisionPoints: collectDecisionPoints(messages, meta),
					resumeNote: meta.resumeNote ?? null,
					readSetDiff,
					resumeCard,
					resumeCardDismissed,
				});
			}
			if (sub === "cancel" && request.method === "POST") {
				chat.cancel(threadId);
				return Response.json({ ok: true });
			}
			if (sub === "reload" && request.method === "POST") {
				return Response.json(await chat.reload(threadId));
			}
			if (sub === "promote" && request.method === "POST") {
				// TF-0092：手动晋升——任意时刻一个手势命名无名对话
				return Response.json(await chat.promote(threadId));
			}
			if (sub === "fork" && request.method === "POST") {
				// TF-0093：追溯式分叉——锚点消息一个手势，零仪式
				const body = (await request.json().catch(() => ({}))) as {
					anchorMessageId?: string;
				};
				if (!body.anchorMessageId) {
					return Response.json(
						{ ok: false, reason: "缺少 anchorMessageId" },
						{ status: 400 },
					);
				}
				return Response.json(await chat.fork(threadId, body.anchorMessageId));
			}
			if (sub === "leave" && request.method === "POST") {
				// TF-0097：离开车道时生成恢复笔记（agent 起草），空对话返回 null
				return Response.json(await chat.leave(threadId));
			}
			if (sub === "switch" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as {
					fromThreadId?: string | null;
				};
				await chat.recordSwitch(body.fromThreadId ?? null, threadId);
				return Response.json({ ok: true });
			}
			if (sub === "restore" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as {
					fromThreadId?: string | null;
				};
				await chat.recordRestored(threadId, body.fromThreadId ?? null);
				return Response.json({ ok: true });
			}
			if (sub === "resume-note/consume" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as {
					surface?: string;
				};
				await chat.recordResumeNoteConsumed(
					threadId,
					typeof body.surface === "string" && body.surface.trim()
						? body.surface.slice(0, 80)
						: "card",
				);
				return Response.json({ ok: true });
			}
			if (sub === "resume-note/dismiss" && request.method === "POST") {
				await chat.recordResumeAction(threadId, "resume_card_dismissed");
				return Response.json({ ok: true });
			}
			if (sub === "resume-action" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as {
					action?: string;
				};
				if (typeof body.action !== "string" || !body.action.trim()) {
					return Response.json(
						{ ok: false, reason: "缺少 action" },
						{ status: 400 },
					);
				}
				await chat.recordResumeAction(threadId, body.action.slice(0, 80));
				return Response.json({ ok: true });
			}
			if (sub === "resume-note" && request.method === "PATCH") {
				// TF-0097：用户编辑/确认恢复笔记
				const body = (await request.json().catch(() => ({}))) as {
					beats?: {
						kind: "doing" | "decided" | "shifted" | "next";
						text: string;
					}[];
					confirmed?: boolean;
				};
				const result = await chat.setResumeNote(threadId, body);
				if (!result) {
					return Response.json(
						{ ok: false, reason: "该线程没有恢复笔记" },
						{ status: 404 },
					);
				}
				return Response.json(result);
			}
			if (sub === undefined && request.method === "DELETE") {
				const outcome = await chat.remove(threadId);
				return Response.json(outcome, { status: outcome.ok ? 200 : 409 });
			}
			if (sub === undefined && request.method === "PATCH") {
				const body = (await request.json()) as {
					title?: string;
					permissionMode?: "default" | "plan" | "acceptEdits";
				};
				return Response.json(await chat.update(threadId, body));
			}
			if (sub === "messages" && request.method === "POST") {
				const body = (await request.json()) as {
					text?: string;
					resend?: boolean;
				};
				if (!body.text?.trim()) {
					return Response.json({ error: "text is required" }, { status: 400 });
				}
				const stream = new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();
						// cancel can resolve the run while a final event is still in
						// flight — once closed, drop anything late instead of throwing
						let closed = false;
						const emit = (event: Record<string, unknown>) => {
							if (closed) {
								return;
							}
							try {
								controller.enqueue(
									encoder.encode(`${JSON.stringify(event)}
`),
								);
							} catch {
								closed = true;
							}
						};
						const close = () => {
							if (closed) {
								return;
							}
							closed = true;
							try {
								controller.close();
							} catch {
								// already closed by the peer
							}
						};
						chat
							.run(threadId, body.text as string, emit, {
								resend: Boolean(body.resend),
							})
							.then(close)
							.catch((error) => {
								emit({ type: "error", message: String(error) });
								close();
							});
					},
				});
				return new Response(stream, {
					headers: { "content-type": "application/x-ndjson" },
				});
			}
		}

		if (!url.pathname.startsWith("/api")) {
			// static SPA with history fallback: exact asset, else index.html
			const direct =
				url.pathname === "/"
					? await readAsset("/")
					: await readAsset(url.pathname);
			if (direct) {
				return direct;
			}
			const index = await readAsset("/");
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
	});

	// R2: detect and deliver are two different jobs, and only the second one
	// needs a live session. Detection writes into the event log; the drain
	// below owns delivery (between turns, via the session's streaming-input
	// stdin — append-only, so the KV cache survives). Splitting them also
	// means notices recorded by the watcher while this process was down get
	// delivered here rather than rotting in the log.
	const RECONCILE_INTERVAL_MS = 15_000;
	const reconcileTimer = setInterval(() => {
		void (async () => {
			await reconcilePremises(bb).catch(() => {});
			const config = await bb.config.load().catch(() => null);
			await drainPremiseQueue(bb, {
				tokenBudget: config?.chat.noticeTokenBudget,
				deliver: (writerId, message, noticeId) =>
					chat.notifySession(writerId, message, noticeId),
			}).catch(() => {});
		})();
	}, RECONCILE_INTERVAL_MS);

	// Object.assign 会用覆盖版替换掉 server 上可写的 stop——先把原型方法
	// 固定住，否则覆盖版调用 server.stop(...) 会无限递归回自己。
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
