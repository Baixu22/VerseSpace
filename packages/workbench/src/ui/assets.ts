import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

export const MIME: Record<string, string> = {
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

export function mimeFor(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot < 0
		? "application/octet-stream"
		: (MIME[path.slice(dot)] ?? "application/octet-stream");
}

export const FALLBACK_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Workbench</title>
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

export async function loadEmbeddedFiles(): Promise<Record<string, string>> {
	try {
		const mod = (await import("./assets.generated.js")) as {
			files: Record<string, string>;
		};
		// JS bundles emit file imports relative to the bundle, not the user's
		// workspace. Compiled binaries already provide absolute virtual paths.
		return Object.fromEntries(
			Object.entries(mod.files ?? {}).map(([key, path]) => [
				key,
				isAbsolute(path) ? path : resolve(import.meta.dir, path),
			]),
		);
	} catch {
		return {};
	}
}

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
	// import.meta.dir is packages/workbench/src/ui — four levels up to the repo
	// root. Three resolved to packages/apps/… which never exists, so source-mode
	// `workbench ui` always served the fallback page (the empty dashboard
	// reported on 2026-09-06).
	const devDist = resolve(
		import.meta.dir,
		"../../../../apps/workbench-ui/dist",
	);
	if (existsSync(join(devDist, "index.html"))) {
		return { kind: "disk", diskDir: devDist };
	}
	return { kind: "none" };
}

export function assetResponse(
	body: ReadableStream | string,
	path: string,
): Response {
	return new Response(body, { headers: { "content-type": mimeFor(path) } });
}
export async function readUiAsset(
	assets: UiAssets,
	urlPath: string,
): Promise<Response | null> {
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
