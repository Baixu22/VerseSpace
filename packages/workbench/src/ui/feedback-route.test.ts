import { expect, test } from "bun:test";
import { makeTempWorkbench } from "../test/fixtures";
import { createUiServer } from "./server";

// TF-0261 (stage B): /api/chat/feedback is the feedback/recovery class of write
// API. It used to append whatever the client sent to events.jsonl — including a
// body with no fields at all — so a bad request became an audit record. It is
// schema-validated now: a bad request is a 400 with no event, and an event is
// only ever written from a validated payload.

async function withServer(
	run: (ctx: {
		bb: Awaited<ReturnType<typeof makeTempWorkbench>>["bb"];
		call: (body: string, contentType?: string) => Promise<Response>;
	}) => Promise<void>,
): Promise<void> {
	const ws = await makeTempWorkbench();
	const server = await createUiServer(ws.bb, 0);
	const call = (body: string, contentType = "application/json") =>
		server.handle(
			new Request(`http://127.0.0.1:${server.port}/api/chat/feedback`, {
				method: "POST",
				headers: {
					"x-workbench-token": server.authToken,
					"content-type": contentType,
				},
				body,
			}),
		);
	try {
		await run({ bb: ws.bb, call });
	} finally {
		server.stop(true);
		await ws.cleanup();
	}
}

test("valid feedback writes exactly the validated payload", async () => {
	await withServer(async ({ bb, call }) => {
		const response = await call(
			JSON.stringify({
				threadId: "t-1",
				messageId: "m-1",
				kind: "positive",
				// an unknown field must not reach the audit log
				evil: "payload",
			}),
		);
		expect(response.status).toBe(200);

		const events = await bb.events.query({ type: "feedback" });
		expect(events).toHaveLength(1);
		expect(events[0]?.payload).toEqual({
			threadId: "t-1",
			messageId: "m-1",
			kind: "positive",
		});
	});
});

test("malformed JSON is a 400 and writes no event", async () => {
	await withServer(async ({ bb, call }) => {
		const before = await bb.events.all();
		for (const body of ["{", "not json", "[]", "null"]) {
			expect((await call(body)).status).toBe(400);
		}
		expect(await bb.events.all()).toEqual(before);
	});
});

test("a missing or mistyped field is a 400 and writes no event", async () => {
	await withServer(async ({ bb, call }) => {
		const before = await bb.events.all();
		for (const body of [
			"{}",
			JSON.stringify({ threadId: "t-1", messageId: "m-1" }),
			JSON.stringify({ threadId: "t-1", messageId: "m-1", kind: "meh" }),
			JSON.stringify({ threadId: "", messageId: "m-1", kind: "positive" }),
		]) {
			expect((await call(body)).status).toBe(400);
		}
		expect(await bb.events.all()).toEqual(before);
	});
});
