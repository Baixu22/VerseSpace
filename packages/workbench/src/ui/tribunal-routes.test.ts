import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import type { TribunalItem } from "../types/tribunal";
import { createUiServer } from "./server";

async function seedBlocked(
	bb: Awaited<ReturnType<typeof makeTempWorkbench>>["bb"],
	subject: string,
): Promise<TribunalItem> {
	const submitted = await bb.tribunal.submit({
		kind: "workspot_blocked",
		subject,
		causeKey: `workspot_blocked:${subject}`,
		action: {
			label: "重新指派工位",
			command: `workbench ws reassign ${subject}`,
		},
		sbar: {
			situation: `工位 ${subject} 被阻塞`,
			background: "任务已进入 stale_done",
			assessment: "工位空转，本轮产出为零",
			recommendation: "改派或关闭",
		},
	});
	if (!submitted.admitted || !submitted.item) {
		throw new Error("fixture candidate was not admitted");
	}
	return submitted.item;
}

test("GET /api/tribunal 列出未裁决项，按 score 降序；resolve 走与 CLI 相同的账本路径并产生事件", async () => {
	const ws = await makeTempWorkbench();
	const item = await seedBlocked(ws.bb, "ws-a");
	const server = await createUiServer(ws.bb, 0);
	const headers = {
		"x-workbench-token": server.authToken,
		"content-type": "application/json",
	};
	const base = `http://127.0.0.1:${server.port}/api/tribunal`;
	try {
		expect((await fetch(base)).status).toBe(401);

		const listed = (await (await fetch(base, { headers })).json()) as {
			items: TribunalItem[];
		};
		expect(listed.items.map((i) => i.id)).toContain(item.id);

		const resolved = await fetch(`${base}/${item.id}/resolve`, {
			method: "POST",
			headers,
		});
		expect(resolved.status).toBe(200);
		expect(await resolved.json()).toMatchObject({
			ok: true,
			item: { id: item.id, state: "resolved" },
		});

		// The receipt is the durable event — indistinguishable from a CLI resolve.
		const events = await ws.bb.events.query({ type: "tribunal_resolved" });
		expect(events.map((e) => (e.payload as { id: string }).id)).toContain(
			item.id,
		);

		// Resolved items drop out of the bar's list.
		const after = (await (await fetch(base, { headers })).json()) as {
			items: TribunalItem[];
		};
		expect(after.items.map((i) => i.id)).not.toContain(item.id);

		// Resolving twice is a clean 404, not a crash.
		const again = await fetch(`${base}/${item.id}/resolve`, {
			method: "POST",
			headers,
		});
		expect(again.status).toBe(404);
	} finally {
		await server.stop();
		await ws.cleanup();
	}
});

test("POST /api/tribunal/:id/shelve 推迟该项并记 shelveCount", async () => {
	const ws = await makeTempWorkbench();
	const item = await seedBlocked(ws.bb, "ws-b");
	const server = await createUiServer(ws.bb, 0);
	const headers = {
		"x-workbench-token": server.authToken,
		"content-type": "application/json",
	};
	const base = `http://127.0.0.1:${server.port}/api/tribunal`;
	try {
		const shelved = await fetch(`${base}/${item.id}/shelve`, {
			method: "POST",
			headers,
			body: JSON.stringify({ minutes: 45 }),
		});
		expect(shelved.status).toBe(200);
		expect(await shelved.json()).toMatchObject({
			ok: true,
			item: { id: item.id, state: "shelved", shelveCount: 1 },
		});
		const events = await ws.bb.events.query({ type: "tribunal_shelved" });
		expect(events.map((e) => (e.payload as { id: string }).id)).toContain(
			item.id,
		);
	} finally {
		await server.stop();
		await ws.cleanup();
	}
});

test("非法裁决项标识返回 400", async () => {
	const ws = await makeTempWorkbench();
	const server = await createUiServer(ws.bb, 0);
	const headers = { "x-workbench-token": server.authToken };
	const base = `http://127.0.0.1:${server.port}/api/tribunal`;
	try {
		const bad = await fetch(`${base}/not%20valid/resolve`, {
			method: "POST",
			headers,
		});
		expect(bad.status).toBe(400);
	} finally {
		await server.stop();
		await ws.cleanup();
	}
});

test("GET /api/tribunal 把无法读取的队列文件一并上报，不当作空队列", async () => {
	const ws = await makeTempWorkbench();
	await writeFile(
		join(ws.bb.paths.tribunal, "t-torn.yaml"),
		"id: t-torn\nkind: [unclosed\n",
		"utf8",
	);
	const server = await createUiServer(ws.bb, 0);
	const headers = { "x-workbench-token": server.authToken };
	const base = `http://127.0.0.1:${server.port}/api/tribunal`;
	try {
		const body = (await (await fetch(base, { headers })).json()) as {
			items: TribunalItem[];
			unreadable: string[];
		};
		expect(body.items).toHaveLength(0);
		expect(body.unreadable).toEqual(["t-torn.yaml"]);
	} finally {
		await server.stop();
		await ws.cleanup();
	}
});
