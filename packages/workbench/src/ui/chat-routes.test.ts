import { expect, test } from "bun:test";
import { ChatThreads } from "../chat/threads";
import { makeTempWorkbench } from "../test/fixtures";
import { createUiServer } from "./server";

// TF-0256 (F-04): the write routes that used request.json().catch(() => ({}))
// must reject a malformed body with 400 and leave no trace — no thread, no
// event, no observation. server.handle is driven directly with a Request so
// the assertion never touches the network stack (and never the injected
// loopback proxy). The four routes in scope: create, switch,
// resume-note/consume, resume-card/shown.

async function withServer(
	run: (ctx: {
		bb: Awaited<ReturnType<typeof makeTempWorkbench>>["bb"];
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
		await run({ bb: ws.bb, chat, call });
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
