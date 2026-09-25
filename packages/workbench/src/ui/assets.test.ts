import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { mimeFor, readUiAsset, type UiAssets } from "./assets";
import { createUiServer } from "./server";

// TF-0257 (F-05): a broken UI build must be a distinguishable failure, not a
// 200 that renders an empty shell. Two identity points:
//   1. readUiAsset over an embedded manifest whose target file is gone must
//      MISS (return null), so it cannot stream an empty 200.
//   2. the server fallback must be non-2xx AND carry a machine-readable
//      `x-workbench-ui-assets: missing` header, so deployment monitoring can
//      tell "UI healthy" from "UI assets failed to load".

test("readUiAsset: embedded manifest entry pointing at a missing file misses", async () => {
	const assets: UiAssets = {
		kind: "embedded",
		embeddedFiles: {
			"index.html": join(
				tmpdir(),
				"workbench-does-not-exist-xyz",
				"index.html",
			),
		},
	};
	// a corrupt manifest (entry present, file gone) must not resolve to a
	// broken 200 stream — it must miss so the caller surfaces the fallback
	expect(await readUiAsset(assets, "/")).toBeNull();
	expect(await readUiAsset(assets, "/index.html")).toBeNull();
});

test("readUiAsset: embedded manifest entry that exists is served", async () => {
	const dir = await mkdtemp(join(tmpdir(), "workbench-embed-"));
	try {
		const file = join(dir, "index.html");
		await writeFile(file, "<!doctype html><title>ok</title>", "utf8");
		const assets: UiAssets = {
			kind: "embedded",
			embeddedFiles: { "index.html": file },
		};
		const response = await readUiAsset(assets, "/");
		expect(response).not.toBeNull();
		expect(response!.status).toBe(200);
		expect(response!.headers.get("content-type")).toContain("text/html");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("server: assets missing → fallback is 503 with x-workbench-ui-assets: missing", async () => {
	const ws = await makeTempWorkbench();
	// an empty ui dir has no index.html: every asset lookup misses and the
	// server falls back — the failure a monitor must be able to see
	const emptyDir = await mkdtemp(join(tmpdir(), "workbench-empty-ui-"));
	const server = await createUiServer(ws.bb, 0, emptyDir);
	try {
		const base = `http://127.0.0.1:${server.port}`;
		const root = await server.handle(new Request(`${base}/`));
		expect(root.status).toBe(503);
		expect(root.headers.get("x-workbench-ui-assets")).toBe("missing");
		// a client route (SPA history fallback) is the same failure, not a 200
		const route = await server.handle(new Request(`${base}/some/route`));
		expect(route.status).toBe(503);
		expect(route.headers.get("x-workbench-ui-assets")).toBe("missing");
	} finally {
		server.stop(true);
		await rm(emptyDir, { recursive: true, force: true });
		await ws.cleanup();
	}
});

test("server: a healthy disk build serves 200 without the missing marker", async () => {
	const ws = await makeTempWorkbench();
	const uiDir = await mkdtemp(join(tmpdir(), "workbench-ok-ui-"));
	await mkdir(uiDir, { recursive: true });
	await writeFile(
		join(uiDir, "index.html"),
		"<!doctype html><title>Workbench</title><body>dashboard</body>",
		"utf8",
	);
	const server = await createUiServer(ws.bb, 0, uiDir);
	try {
		const base = `http://127.0.0.1:${server.port}`;
		const root = await server.handle(new Request(`${base}/`));
		expect(root.status).toBe(200);
		expect(root.headers.get("x-workbench-ui-assets")).toBeNull();
	} finally {
		server.stop(true);
		await rm(uiDir, { recursive: true, force: true });
		await ws.cleanup();
	}
});

test("mimeFor: unknown extensions fall back to octet-stream, known ones map", () => {
	expect(mimeFor("index.html")).toContain("text/html");
	expect(mimeFor("app.js")).toContain("javascript");
	expect(mimeFor("weird.xyz")).toBe("application/octet-stream");
	expect(mimeFor("noext")).toBe("application/octet-stream");
});
