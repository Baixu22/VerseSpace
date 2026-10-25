import { expect, spyOn, test } from "bun:test";
import type { Command } from "commander";
import { collectRestoreView } from "../chat/restore-view";
import { ChatThreads } from "../chat/threads";
import { sessionsShowCommand } from "../commands/sessions";
import { makeTempWorkbench } from "../test/fixtures";
import {
	createInputCoverage,
	inputCoverageView,
	recordInputCoverage,
} from "./input-coverage";

test("CLI JSON uses the same latest-turn coverage and does not mutate the event ledger", async () => {
	const ws = await makeTempWorkbench();
	const previous = process.cwd();
	try {
		await ws.bb.sessions.register("w", "agent");
		const tracker = createInputCoverage();
		tracker.begin("missing");
		tracker.settle("missing", []);
		await recordInputCoverage(ws.bb, "w", tracker.finish());
		const expected = await inputCoverageView(ws.bb, "w");
		const before = await ws.bb.events.all();
		process.chdir(ws.projectDir);
		const outputs: string[] = [];
		const log = spyOn(console, "log").mockImplementation((value) => {
			outputs.push(String(value));
		});
		try {
			await sessionsShowCommand({ writer: "w" }, {
				optsWithGlobals: () => ({ json: true }),
			} as unknown as Command);
		} finally {
			log.mockRestore();
		}
		expect(JSON.parse(outputs.join("\n")).inputCoverage).toEqual(expected);
		expect(await ws.bb.events.all()).toEqual(before);
	} finally {
		process.chdir(previous);
		await ws.cleanup();
	}
});

test("a real HTTP turn records unobservable coverage regardless of a successful model response", async () => {
	const ws = await makeTempWorkbench();
	const server = Bun.serve({
		port: 0,
		fetch: () =>
			new Response(
				'data: {"choices":[{"delta":{"content":"HTTP answer"}}]}\n\n' +
					'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
					"data: [DONE]\n\n",
				{ headers: { "content-type": "text/event-stream" } },
			),
	});
	try {
		const config = await ws.bb.config.load();
		config.chat = {
			...config.chat,
			provider: "openai-chat",
			model: "test",
			apiKey: "local-fixture",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		};
		await ws.bb.config.save(config);
		const chat = new ChatThreads(ws.bb);
		const thread = await chat.create();
		await chat.run(thread.id, "answer", () => {});
		const view = await inputCoverageView(ws.bb, thread.id);
		expect(view).toMatchObject({
			status: "unobservable",
			observedRatio: null,
			coverage: { candidates: 0, observedEvents: 0 },
		});
		expect(
			(await collectRestoreView(ws.bb, chat, thread.id)).inputCoverage,
		).toEqual(view);
		expect((await chat.messages(thread.id)).at(-1)?.text).toBe("HTTP answer");
	} finally {
		server.stop(true);
		await ws.cleanup();
	}
});

test("anonymous candidates are counted individually, remain unknown, and are not merged by a placeholder id", () => {
	const tracker = createInputCoverage();
	tracker.begin();
	tracker.begin();
	tracker.begin("act-unknown");
	tracker.settle("act-unknown", []);
	const result = tracker.finish();
	expect(result).toMatchObject({
		candidates: 3,
		pending: 3,
		successful: 0,
		observedEvents: 0,
	});
});
