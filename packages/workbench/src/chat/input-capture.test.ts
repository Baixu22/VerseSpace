import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentCapture } from "../agents/capture";
import { claimObservation } from "../blackboard/claim-version";
import { extractFootprint } from "../blackboard/footprint";
import { captureReturnedInput } from "../blackboard/footprint-sample";
import { hashText } from "../hash";
import { makeTempWorkbench } from "../test/fixtures";
import { claudeReturnedInput } from "./claude-input";
import { createClaudeRenderState } from "./claude-render-state";
import { registerTurnRouter } from "./claude-router";
import type { ActiveTurn, LiveClaudeSession } from "./claude-types";
import { createCodexRenderState } from "./codex-render-state";
import { type CodexTurnState, routeCodexEvent } from "./codex-router";
import type { ThreadContext } from "./thread-context";

async function retainedRead() {
	const events = (
		await readFile(
			join(import.meta.dir, "fixtures/streams/claude/bash-and-edit.jsonl"),
			"utf8",
		)
	)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const call = events.find((e) =>
		e.message?.content?.some((b: { id: string }) => b.id === "toolu_5"),
	);
	const result = events.find((e) =>
		e.message?.content?.some(
			(b: { tool_use_id: string }) => b.tool_use_id === "toolu_5",
		),
	);
	return {
		call,
		result,
		content: result.tool_use_result.file.content as string,
	};
}

function claudeTurn(): ActiveTurn {
	return {
		...createClaudeRenderState(),
		pendingFootprints: new Map(),
		fpQueue: Promise.resolve(),
		undecidedEventTypes: new Set(),
		inheritanceStarted: true,
		inheritancePromise: Promise.resolve(),
		stderr: "",
		sawInit: false,
		finished: false,
		noticeAcked: false,
		noticeAckPromise: Promise.resolve(),
		noticeCount: 0,
		resolve: () => {},
		emit: () => {},
	};
}

function codexTurn(): CodexTurnState {
	return {
		render: createCodexRenderState(),
		pendingFootprints: new Map(),
		fpQueue: Promise.resolve(),
		undecidedEventTypes: new Set(),
		emit: () => {},
	};
}

test("retained Claude Read binds original returned content in chat and batch despite later file writes", async () => {
	const ws = await makeTempWorkbench();
	try {
		const { call, result, content } = await retainedRead();
		const current = content.replace("0.1.0", "0.2.0");
		await writeFile(join(ws.projectDir, "package.json"), content);
		await ws.bb.sessions.register("chat", "agent");
		await ws.bb.sessions.register("batch", "agent");
		const turn = claudeTurn();
		const context = {
			bb: ws.bb,
			lineRouters: new Map(),
		} as unknown as ThreadContext;
		registerTurnRouter(context, "chat", { turn } as LiveClaudeSession);
		const route = context.lineRouters.get("chat")!;
		const batch = await createAgentCapture(ws.bb, "batch", "ws", ws.projectDir);
		for (const event of [call, call]) {
			route(JSON.stringify(event));
			batch.line(JSON.stringify(event));
		}
		// The tool's immutable result still describes v1; the file now contains v2.
		await writeFile(join(ws.projectDir, "package.json"), current);
		for (const event of [result, result, call, result]) {
			route(JSON.stringify(event));
			batch.line(JSON.stringify(event));
		}
		await turn.fpQueue;
		await batch.finish();
		for (const id of ["chat", "batch"]) {
			const lines = await ws.bb.sessions.footprint(id);
			expect(lines).toHaveLength(1);
			const used = lines[0]!.used[0]!;
			expect(used.version).toBe(hashText(current));
			expect(claimObservation(used)).toMatchObject({
				source: "tool-observed",
				binding: "different",
				contentHash: hashText(content),
				returnedHash: hashText(result.message.content[0].content),
			});
			expect(lines[0]!.eventId).toBeTruthy();
		}
	} finally {
		await ws.cleanup();
	}
});

test("retained Codex single cat is bound at completion and duplicate results cannot refresh it", async () => {
	const ws = await makeTempWorkbench();
	try {
		const events = (
			await readFile(
				join(
					import.meta.dir,
					"fixtures/streams/codex/command-with-delta.jsonl",
				),
				"utf8",
			)
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line))
			.filter((e) => e.item?.id === "call_1");
		for (const event of events) {
			event.item.cwd = ws.projectDir;
			event.item.commandActions[0].path = join(ws.projectDir, "package.json");
		}
		const returned = events[1].item.aggregatedOutput as string;
		await ws.bb.sessions.register("codex", "agent");
		await writeFile(join(ws.projectDir, "package.json"), returned);
		const turn = codexTurn();
		const context = { bb: ws.bb } as ThreadContext;
		routeCodexEvent(context, "codex", turn, events[0]);
		await writeFile(join(ws.projectDir, "package.json"), "new file\n");
		routeCodexEvent(context, "codex", turn, events[1]);
		await turn.fpQueue;
		routeCodexEvent(context, "codex", turn, events[1]);
		await turn.fpQueue;
		const lines = await ws.bb.sessions.footprint("codex");
		expect(lines).toHaveLength(1);
		expect(claimObservation(lines[0]!.used[0]!)).toMatchObject({
			source: "tool-observed",
			binding: "different",
			contentHash: hashText(returned),
		});
		const failed = structuredClone(events[1]);
		failed.item.id = "failed";
		failed.item.exitCode = 1;
		routeCodexEvent(context, "codex", turn, failed);
		await turn.fpQueue;
		expect(await ws.bb.sessions.footprint("codex")).toHaveLength(1);
	} finally {
		await ws.cleanup();
	}
});

test("Claude partial ranges retain exact content, CRLF normalization, and reject truncated or mismatched returns", async () => {
	const ws = await makeTempWorkbench();
	try {
		const { call, result, content } = await retainedRead();
		call.message.content[0].input = {
			file_path: "package.json",
			offset: 2,
			limit: 3,
		};
		const selected = content.split("\n").slice(1, 4).join("\n");
		result.tool_use_result.file = {
			...result.tool_use_result.file,
			content: selected,
			startLine: 2,
			numLines: 3,
		};
		result.message.content[0].content = selected
			.split("\n")
			.map((line, i) => `${i + 2}\t${line}`)
			.join("\n");
		const fp = extractFootprint(call, "reader")!;
		const block = result.message.content[0];
		await writeFile(
			join(ws.projectDir, "package.json"),
			content.replace(/\n/g, "\r\n"),
		);
		const returned = claudeReturnedInput(ws.projectDir, fp, block, result);
		const used = await captureReturnedInput(
			ws.projectDir,
			"package.json",
			returned,
			undefined,
			fp.used[0]!.span,
		);
		expect(claimObservation(used)).toMatchObject({
			source: "tool-observed",
			binding: "matched",
			contentHash: hashText(selected),
			selector: { kind: "lines", start: 2, end: 4 },
		});
		for (const mutate of [
			(e: typeof result) => {
				e.tool_use_result.file.numLines = 2;
			},
			(e: typeof result) => {
				e.tool_use_result.file.filePath = "other.json";
			},
			(e: typeof result) => {
				e.tool_use_result.file.truncated = true;
			},
			(e: typeof result) => {
				e.message.content[0].content = "2\tchanged";
			},
			(e: typeof result) => {
				delete e.tool_use_result;
			},
		]) {
			const bad = structuredClone(result);
			mutate(bad);
			expect(
				claudeReturnedInput(ws.projectDir, fp, bad.message.content[0], bad),
			).toHaveProperty("reason");
		}
	} finally {
		await ws.cleanup();
	}
});
