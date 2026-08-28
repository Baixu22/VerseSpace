import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Blackboard } from "../blackboard";
import { runDoctor } from "../doctor";
import { WORKBENCH_VERSION } from "../version";
import { files as embeddedFiles } from "./assets.generated.js";

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
		bb.events.tail(50),
		runDoctor(bb),
	]);
	return {
		version: WORKBENCH_VERSION,
		project: bb.projectRoot,
		config,
		goals,
		queue,
		workspots,
		checkpoints,
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
}

/**
 * Resolution order: explicit --ui-dir > embedded assets (compiled binary) >
 * the repo dev build (apps/workbench-ui/dist) > none (fallback page).
 */
export function resolveUiAssets(uiDirOverride?: string): UiAssets {
	if (uiDirOverride) {
		return { kind: "disk", diskDir: resolve(uiDirOverride) };
	}
	if (Object.keys(embeddedFiles).length > 0) {
		return { kind: "embedded" };
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

export function createUiServer(
	bb: Blackboard,
	port: number,
	uiDirOverride?: string,
) {
	const assets = resolveUiAssets(uiDirOverride);

	async function readAsset(urlPath: string): Promise<Response | null> {
		const key = urlPath.replace(/^\/+/, "") || "index.html";
		if (assets.kind === "embedded") {
			const embedded = embeddedFiles[key];
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
