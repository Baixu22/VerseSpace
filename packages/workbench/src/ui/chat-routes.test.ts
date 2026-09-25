import { expect, test } from "bun:test";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatThreads } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import { createUiServer } from "./server";

// TF-0256 (F-04): the write routes that used request.json().catch(() => ({}))
// must reject a malformed body with 400 and leave no trace — no thread, no
// event, no observation. server.handle is driven directly with a Request so
// the assertion never touches the network stack (and never the injected
// loopback proxy). The four routes in scope: create, switch,
// resume-note/consume, resume-card/shown.
//
// TF-0261 (sweep, 2026-09-25): the same collapse survived in three more
// handlers. `restore` and `resume-note` are covered at the bottom of this file
// (the third, `/api/tribunal/:id/shelve`, lives in tribunal-routes.test.ts).

async function withServer(
	run: (ctx: {
		bb: Awaited<ReturnType<typeof makeTempWorkbench>>["bb"];
		ws: Awaited<ReturnType<typeof makeTempWorkbench>>;
		chat: ChatThreads;
		call: (
			path: string,
			method: string,
			body?: string,
			contentType?: string,
		) => Promise<Response>;
	}) => Promise<void>,
): Promise<void> {
	const ws = await makeTempWorkbench();
	const chat = new ChatThreads(ws.bb);
	const server = await createUiServer(ws.bb, 0);
	const call = (
		path: string,
		method: string,
		body?: string,
		contentType = "application/json",
	) =>
		server.handle(
			new Request(`http://127.0.0.1:${server.port}${path}`, {
				method,
				headers: {
					"x-workbench-token": server.authToken,
					"content-type": contentType,
				},
				body,
			}),
		);
	try {
		await run({ bb: ws.bb, ws, chat, call });
	} finally {
		server.stop(true);
		await ws.cleanup();
	}
}

const MALFORMED = ["{", "not json", "[]", "null", "42", '"a string"'] as const;

test("create: malformed body → 400, no thread, no thread.created event", async () => {
	await withServer(async ({ bb, chat, call }) => {
		const before = await bb.events.all();
		for (const body of MALFORMED) {
			const response = await call("/api/chat/threads", "POST", body);
			expect(response.status).toBe(400);
		}
		// nothing was created and nothing was recorded
		expect(await chat.list()).toEqual([]);
		expect(await bb.events.all()).toEqual(before);

		// the empty object is still a valid create (the UI sends "{}")
		const ok = await call("/api/chat/threads", "POST", "{}");
		expect(ok.status).toBe(200);
		expect(await chat.list()).toHaveLength(1);
	});
});

test("switch: malformed body → 400, no thread.switch event", async () => {
	await withServer(async ({ bb, chat, call }) => {
		const thread = await chat.create();
		const before = await bb.events.all();
		for (const body of MALFORMED) {
			const response = await call(
				`/api/chat/threads/${thread.id}/switch`,
				"POST",
				body,
			);
			expect(response.status).toBe(400);
		}
		expect(await bb.events.all()).toEqual(before);

		// a well-formed body still records the switch
		const ok = await call(
			`/api/chat/threads/${thread.id}/switch`,
			"POST",
			JSON.stringify({ fromThreadId: null }),
		);
		expect(ok.status).toBe(200);
		expect(
			(await bb.events.all()).some((e) => e.type === "thread.switch"),
		).toBe(true);
	});
});

test("resume-note/consume and resume-card/shown: malformed body → 400, no event", async () => {
	await withServer(async ({ bb, chat, call }) => {
		const thread = await chat.create();
		const before = await bb.events.all();
		for (const suffix of ["/resume-note/consume", "/resume-card/shown"]) {
			for (const body of MALFORMED) {
				const response = await call(
					`/api/chat/threads/${thread.id}${suffix}`,
					"POST",
					body,
				);
				expect(response.status).toBe(400);
			}
		}
		expect(await bb.events.all()).toEqual(before);
	});
});

// TF-0261 sweep: `{}` used to satisfy the all-optional observation schema, so a
// malformed body appended a `thread.restored` fact that observed nothing.
test("restore: malformed body → 400, no thread.restored event", async () => {
	await withServer(async ({ bb, chat, call }) => {
		const thread = await chat.create();
		const before = await bb.events.all();
		for (const body of MALFORMED) {
			const response = await call(
				`/api/chat/threads/${thread.id}/restore`,
				"POST",
				body,
			);
			expect(response.status).toBe(400);
		}
		expect(await bb.events.all()).toEqual(before);

		// a well-formed observation still records the restore
		const ok = await call(
			`/api/chat/threads/${thread.id}/restore`,
			"POST",
			JSON.stringify({ resumeCardVisible: true }),
		);
		expect(ok.status).toBe(200);
		expect(
			(await bb.events.all()).some((e) => e.type === "thread.restored"),
		).toBe(true);
	});
});

// TF-0261 sweep: the body was an unchecked cast, so `{"beats":"evil"}` was
// persisted verbatim into the thread meta by setResumeNote.
test("resume-note PATCH: malformed or mistyped body → 400, meta unchanged", async () => {
	await withServer(async ({ ws, chat, call }) => {
		const thread = await chat.create();
		// seed a transcript, then leave: that is what creates the resume note
		for (const m of [
			{ id: "m-1", role: "user", text: "调研恢复笔记" },
			{ id: "m-2", role: "assistant", text: "好" },
		]) {
			await appendFile(
				join(ws.workbenchRoot, "threads", thread.id, "messages.jsonl"),
				`${JSON.stringify({ ...m, at: new Date().toISOString() })}\n`,
				"utf8",
			);
		}
		expect(await chat.leave(thread.id)).not.toBeNull();

		// The route runs on the server's own ChatThreads, so the assertion reads
		// the durable meta from disk rather than a second instance's cache.
		const metaFile = join(ws.bb.paths.root, "threads", thread.id, "meta.json");
		const readNote = async () =>
			(
				JSON.parse(await readFile(metaFile, "utf8")) as {
					resumeNote?: { beats: unknown; confirmedAt?: string };
				}
			).resumeNote;
		const before = await readNote();
		expect(before).toBeDefined();

		const path = `/api/chat/threads/${thread.id}/resume-note`;
		for (const body of MALFORMED) {
			expect((await call(path, "PATCH", body)).status).toBe(400);
		}
		// the two shapes the old cast accepted: a non-array, and an unknown kind
		expect(
			(await call(path, "PATCH", JSON.stringify({ beats: "evil" }))).status,
		).toBe(400);
		expect(
			(
				await call(
					path,
					"PATCH",
					JSON.stringify({ beats: [{ kind: "nope", text: "x" }] }),
				)
			).status,
		).toBe(400);
		expect((await readNote())?.beats).toEqual(before?.beats);
		expect((await readNote())?.confirmedAt).toBeUndefined();

		// a well-formed patch still lands
		const ok = await call(path, "PATCH", JSON.stringify({ confirmed: true }));
		expect(ok.status).toBe(200);
		expect((await readNote())?.confirmedAt).toBeDefined();
	});
});
