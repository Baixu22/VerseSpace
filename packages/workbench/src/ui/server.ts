import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Blackboard } from "../blackboard";
import { ChatThreads } from "../chat/threads";
import { runDoctor } from "../doctor";
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

export async function createUiServer(
	bb: Blackboard,
	port: number,
	uiDirOverride?: string,
) {
	const assets = await resolveUiAssets(uiDirOverride);
	const chat = new ChatThreads(bb);

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

	return Bun.serve({
		port,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const url = new URL(request.url);
			const cors = { "access-control-allow-origin": "*" };
			if (url.pathname === "/api/state") {
				return Response.json(await collectState(bb), { headers: cors });
			}
			if (url.pathname === "/api/sync" && request.method === "POST") {
				const { runOnce } = await import("../runtime");
				return Response.json(await runOnce(bb), { headers: cors });
			}
			if (url.pathname === "/api/dispatch" && request.method === "POST") {
				const { dispatchGoal } = await import("../scheduler/dispatch");
				const body = (await request.json()) as {
					goalId?: string;
					workspotId?: string;
				};
				if (!body.goalId) {
					return Response.json(
						{ ok: false, reason: "缺少 goalId" },
						{ status: 400, headers: cors },
					);
				}
				const result = await dispatchGoal(bb, body.goalId, body.workspotId);
				return Response.json(result, {
					status: result.ok ? 200 : 409,
					headers: cors,
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
						{ status: 400, headers: cors },
					);
				}
				const result = await startAgent(bb, {
					workspotId: body.workspotId,
					prompt: body.prompt,
				});
				return Response.json(result, {
					status: result.ok ? 200 : 409,
					headers: cors,
				});
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
						{ status: 400, headers: cors },
					);
				}
				return Response.json(
					await reviewCheckpoint(bb, body.cpId, body.approve),
					{ headers: cors },
				);
			}

			if (url.pathname === "/api/config/chat" && request.method === "GET") {
				const config = await bb.config.load();
				const { apiKey, ...rest } = config.chat;
				return Response.json(
					{ ...rest, hasKey: Boolean(apiKey) },
					{ headers: cors },
				);
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
				return Response.json(
					{ ...rest, hasKey: Boolean(apiKey) },
					{ headers: cors },
				);
			}

			// ── chat runtime: threads + streaming messages ──
			if (url.pathname === "/api/chat/threads" && request.method === "GET") {
				return Response.json(await chat.list(), { headers: cors });
			}
			if (url.pathname === "/api/chat/threads" && request.method === "POST") {
				const body = (await request.json().catch(() => ({}))) as {
					title?: string;
				};
				return Response.json(await chat.create(body.title), { headers: cors });
			}
			const chatMatch = url.pathname.match(
				/^\/api\/chat\/threads\/([^/]+)(\/(messages|cancel))?$/,
			);
			if (chatMatch) {
				const threadId = decodeURIComponent(chatMatch[1] ?? "");
				const sub = chatMatch[3];
				if (!sub && request.method === "GET") {
					const [meta, messages] = await Promise.all([
						chat.get(threadId),
						chat.messages(threadId),
					]);
					return Response.json({ meta, messages }, { headers: cors });
				}
				if (sub === "cancel" && request.method === "POST") {
					chat.cancel(threadId);
					return Response.json({ ok: true }, { headers: cors });
				}
				if (sub === "reload" && request.method === "POST") {
					return Response.json(await chat.reload(threadId), { headers: cors });
				}
				if (sub === undefined && request.method === "PATCH") {
					const body = (await request.json()) as {
						title?: string;
						permissionMode?: "default" | "plan" | "acceptEdits";
					};
					return Response.json(await chat.update(threadId, body), {
						headers: cors,
					});
				}
				if (sub === "messages" && request.method === "POST") {
					const body = (await request.json()) as { text?: string };
					if (!body.text?.trim()) {
						return Response.json(
							{ error: "text is required" },
							{ status: 400, headers: cors },
						);
					}
					const stream = new ReadableStream({
						start(controller) {
							const encoder = new TextEncoder();
							const emit = (event: Record<string, unknown>) => {
								controller.enqueue(
									encoder.encode(`${JSON.stringify(event)}
`),
								);
							};
							chat
								.run(threadId, body.text as string, emit)
								.then(() => controller.close())
								.catch((error) => {
									emit({ type: "error", message: String(error) });
									controller.close();
								});
						},
					});
					return new Response(stream, {
						headers: {
							"content-type": "application/x-ndjson",
							...cors,
						},
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
			return new Response("not found", { status: 404, headers: cors });
		},
	});
}
