import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAgentCapture } from "../agents/capture";
import { readAgentView } from "../agents/view";
import { collectRestoreView } from "../chat/restore-view";
import { ChatThreads } from "../chat/threads";
import { hashText } from "../hash";
import { findMcpTool } from "../mcp/tools";
import { makeTempWorkbench } from "../test/fixtures";
import { isWorldEvent } from "../types/event";
import { captureReturnedInput, hashPathClaim } from "./footprint-sample";
import {
	createInputCoverage,
	inputCoverageSchema,
	inputCoverageView,
	recordInputCoverage,
} from "./input-coverage";

test("coverage names event and path units, retains failures and unknowns and never counts duplicate results twice", async () => {
	const ws = await makeTempWorkbench();
	try {
		await writeFile(join(ws.projectDir, "input.txt"), "input\n");
		const observed = await captureReturnedInput(ws.projectDir, "input.txt", {
			returned: "input\n",
			content: "input\n",
			selector: { kind: "file" },
		});
		const sampled = await hashPathClaim(ws.projectDir, "input.txt");
		const tracker = createInputCoverage();
		for (const id of [
			"observed",
			"sampled",
			"declared",
			"size",
			"unknown",
			"missing",
			"failed",
			"pending",
		]) {
			tracker.begin(id);
			tracker.begin(id);
		}
		tracker.settle("observed", [observed]);
		tracker.settle("sampled", [sampled]);
		tracker.settle("declared", [
			{
				path: "input.txt",
				observation: {
					schemaVersion: 1,
					source: "declared",
					contentHash: hashText("input\n"),
				},
			},
		]);
		tracker.settle("size", [{ path: "large.txt", size: 2_000_001 }]);
		tracker.settle("unknown", [
			{
				path: "unknown.txt",
				observation: { schemaVersion: 1, source: "unknown", reason: "截断" },
			},
		]);
		tracker.settle("missing", []);
		tracker.settle("failed", null);
		expect(tracker.acceptResult("observed")).toBe(true);
		expect(tracker.acceptResult("observed")).toBe(false);
		tracker.settle("observed", []);
		const result = tracker.finish();
		expect(result).toMatchObject({
			candidates: 8,
			successful: 6,
			failed: 1,
			pending: 1,
			observedEvents: 1,
			paths: {
				toolObserved: 1,
				fsSample: 1,
				declared: 1,
				sizeOnly: 1,
				unknown: 1,
			},
			bindings: { matched: 1, different: 0, unknown: 0 },
		});
		expect(result.reasons).toMatchObject({
			工具失败: 1,
			未收到成功结果或缺少工具身份: 1,
			没有可归因的文件路径: 1,
			截断: 1,
		});
		expect(inputCoverageSchema.safeParse(result).success).toBe(true);
		expect(
			inputCoverageSchema.safeParse({ ...result, candidates: 100 }).success,
		).toBe(false);
		await recordInputCoverage(ws.bb, "w", result, "turn");
		expect((await inputCoverageView(ws.bb, "w")).observedRatio).toBe(1 / 8);
		expect(
			isWorldEvent((await ws.bb.events.query({ type: "input_coverage" }))[0]!),
		).toBe(false);
	} finally {
		await ws.cleanup();
	}
});

test("zero tools, HTTP and legacy log gaps have no calculable coverage ratio", async () => {
	const ws = await makeTempWorkbench();
	try {
		expect(await inputCoverageView(ws.bb, "w")).toMatchObject({
			status: "unknown",
			coverage: null,
			observedRatio: null,
		});
		await recordInputCoverage(ws.bb, "w", createInputCoverage().finish());
		expect(await inputCoverageView(ws.bb, "w")).toMatchObject({
			status: "zero",
			observedRatio: null,
		});
		await recordInputCoverage(
			ws.bb,
			"w",
			createInputCoverage("unobservable").finish(),
		);
		expect(await inputCoverageView(ws.bb, "w")).toMatchObject({
			status: "unobservable",
			observedRatio: null,
		});
		await ws.bb.events.append({
			timestamp: new Date().toISOString(),
			source: "capture",
			type: "input_coverage",
			payload: { writer: "w", coverage: { candidates: 3 } },
		});
		expect(await inputCoverageView(ws.bb, "w")).toMatchObject({
			status: "unknown",
			coverage: null,
			observedRatio: null,
		});
	} finally {
		await ws.cleanup();
	}
});

test("batch capture persists received candidate counts, missing paths, failures and unfinished attempts", async () => {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.sessions.register("agent:ws", "agent");
		const capture = await createAgentCapture(
			ws.bb,
			"agent:ws",
			"ws",
			ws.projectDir,
		);
		const call = {
			type: "assistant",
			message: {
				content: [
					{ type: "tool_use", id: "missing", name: "Read", input: {} },
					{
						type: "tool_use",
						id: "failed",
						name: "Read",
						input: { file_path: "input.txt" },
					},
					{
						type: "tool_use",
						id: "pending",
						name: "Read",
						input: { file_path: "input.txt" },
					},
					{
						type: "tool_use",
						id: "shell",
						name: "PowerShell",
						input: { command: "Get-Content input.txt" },
					},
					{ type: "tool_use", id: "nonfile", name: "WebSearch", input: {} },
				],
			},
		};
		capture.line(JSON.stringify(call));
		capture.line(JSON.stringify(call));
		const results = {
			type: "user",
			message: {
				content: [
					{ type: "tool_result", tool_use_id: "missing", content: "no path" },
					{
						type: "tool_result",
						tool_use_id: "failed",
						is_error: true,
						content: "denied",
					},
					{ type: "tool_result", tool_use_id: "shell", content: "unmodeled" },
				],
			},
		};
		capture.line(JSON.stringify(results));
		capture.line(JSON.stringify(results));
		await capture.finish();
		const view = await inputCoverageView(ws.bb, "agent:ws");
		expect(view.coverage).toMatchObject({
			candidates: 4,
			successful: 2,
			failed: 1,
			pending: 1,
			observedEvents: 0,
		});
		expect(view.observedRatio).toBe(0);
		expect((await readAgentView(ws.bb, "ws")).inputCoverage).toEqual(view);
		expect(await ws.bb.sessions.footprint("agent:ws")).toEqual([]);
	} finally {
		await ws.cleanup();
	}
});

test("MCP footprints and restore project exactly the shared coverage without writes", async () => {
	const ws = await makeTempWorkbench();
	try {
		const chat = new ChatThreads(ws.bb);
		const thread = await chat.create();
		const tracker = createInputCoverage();
		tracker.begin("one");
		tracker.settle("one", []);
		await recordInputCoverage(ws.bb, thread.id, tracker.finish());
		const before = await ws.bb.events.all();
		const common = await inputCoverageView(ws.bb, thread.id);
		const restored = await collectRestoreView(ws.bb, chat, thread.id);
		expect(restored.inputCoverage).toEqual(common);
		expect(
			await findMcpTool("footprints")!.run({ writer: thread.id }, ws.bb),
		).toContain(common.text);
		expect(
			await findMcpTool("resume_cards")!.run({ threadId: thread.id }, ws.bb),
		).toContain(common.text);
		expect(await ws.bb.events.all()).toEqual(before);
	} finally {
		await ws.cleanup();
	}
});
