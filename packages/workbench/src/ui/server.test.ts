import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTempWorkbench, type TempWorkbench } from "../test/fixtures";
import { collectState, createUiServer, resolveUiAssets } from "./server";

describe("collectState", () => {
	test("aggregates blackboard and doctor report", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		try {
			const goal = await ws.bb.goals.add({ title: "面板测试" });
			const state = await collectState(ws.bb);
			expect(state.version).toBe("0.2.0");
			expect(state.goals.map((g) => (g as { id: string }).id)).toEqual([
				goal.id,
			]);
			expect(state.doctor.ok).toBe(true);
			expect(state.events).toEqual([]);
		} finally {
			await ws.cleanup();
		}
	});
});

describe("resolveUiAssets", () => {
	test("explicit dir wins; fallback kinds are all valid", async () => {
		const dir = await mkdtemp(join(tmpdir(), "workbench-ui-"));
		try {
			expect(resolveUiAssets(dir)).toEqual({ kind: "disk", diskDir: dir });
			// the placeholder manifest is empty; whether the dev dist exists
			// depends on the checkout — any of the three kinds is acceptable
			const resolved = resolveUiAssets();
			expect(["embedded", "disk", "none"]).toContain(resolved.kind);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("ui server", () => {
	test("serves a disk ui dir with SPA fallback and applies sync via POST", async () => {
		const ws: TempWorkbench = await makeTempWorkbench();
		const uiDir = await mkdtemp(join(tmpdir(), "workbench-spa-"));
		await mkdir(join(uiDir, "assets"), { recursive: true });
		await writeFile(
			join(uiDir, "index.html"),
			"<!doctype html><html><head><title>Workbench</title></head><body>dashboard</body></html>",
			"utf8",
		);
		await writeFile(
			join(uiDir, "assets", "app.js"),
			"console.log('workbench-ui');",
			"utf8",
		);
		const server = createUiServer(ws.bb, 0, uiDir);
		try {
			const base = `http://127.0.0.1:${server.port}`;

			const page = await fetch(base).then((r) => r.text());
			expect(page).toContain("dashboard");

			const asset = await fetch(`${base}/assets/app.js`);
			expect(asset.status).toBe(200);
			expect(await asset.text()).toContain("workbench-ui");
			expect(asset.headers.get("content-type")).toContain("javascript");

			// history fallback serves the SPA for client routes
			expect(await fetch(`${base}/some/route`).then((r) => r.text())).toContain(
				"dashboard",
			);
			const goal = await ws.bb.goals.add({ title: "服务端测试" });
			const state = await fetch(`${base}/api/state`);
			expect(state.headers.get("access-control-allow-origin")).toBe("*");
			const body = await state.json();
			expect(body.goals).toHaveLength(1);
			expect(body.goals[0].id).toBe(goal.id);

			const sync = await fetch(`${base}/api/sync`, { method: "POST" }).then(
				(r) => r.json(),
			);
			expect(sync.applied).toBeGreaterThanOrEqual(1);

			// single-round semantics: the enqueue lands on the NEXT cycle
			await fetch(`${base}/api/sync`, { method: "POST" });
			const after = await fetch(`${base}/api/state`).then((r) => r.json());
			expect(after.goals[0].status).toBe("ready");
			expect(after.queue).toEqual([goal.id]);

			expect(await fetch(`${base}/api/nope`).then((r) => r.status)).toBe(404);
		} finally {
			server.stop(true);
			await rm(uiDir, { recursive: true, force: true });
			await ws.cleanup();
		}
	});
});
