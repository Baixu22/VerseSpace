import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claimObservation } from "../blackboard/claim-version";
import {
	captureReturnedInput,
	hashPathClaim,
} from "../blackboard/footprint-sample";
import { foldReadSet } from "../blackboard/session-view";
import { hashText } from "../hash";
import { makeTempWorkbench } from "../test/fixtures";
import { codexReturnedInput, extractCodexFootprint } from "./codex-footprint";

test("unknown, directory, multi-path, missing fields and unmodeled Get-Content never claim returned file content", async () => {
	const ws = await makeTempWorkbench();
	try {
		await writeFile(join(ws.projectDir, "input.txt"), "actual\n");
		for (const command of [
			"cat input.txt | head -1",
			"cat input.txt other.txt",
			"cat -n input.txt",
			"Get-Content input.txt",
			"cat input.txt; echo extra",
			"cat *.txt",
		]) {
			const item = {
				type: "commandExecution",
				id: command,
				status: "completed",
				exitCode: 0,
				command,
				commandActions: [{ type: "read", path: "input.txt", command }],
				aggregatedOutput: "actual\n",
			};
			const fp = extractCodexFootprint(item, "reader")!;
			expect(codexReturnedInput(ws.projectDir, fp, item)).toHaveProperty(
				"reason",
			);
		}
		for (const returned of [
			{ reason: "缺少工具路径映射" },
			{
				returned: "actual... [truncated]",
				content: "actual",
				selector: { kind: "file" as const },
			},
		]) {
			const used = await captureReturnedInput(
				ws.projectDir,
				"input.txt",
				returned,
			);
			expect(claimObservation(used).source).toBe("unknown");
		}
		const directory = await captureReturnedInput(ws.projectDir, ".", {
			returned: "listing",
			content: "listing",
			selector: { kind: "file" },
		});
		expect(claimObservation(directory)).toMatchObject({
			source: "unknown",
			binding: "unknown",
		});
		const missing = await captureReturnedInput(ws.projectDir, "missing.txt", {
			returned: "observed\n",
			content: "observed\n",
			selector: { kind: "file" },
		});
		expect(claimObservation(missing)).toMatchObject({
			source: "tool-observed",
			binding: "unknown",
		});
		const item = {
			type: "commandExecution",
			id: "missing",
			command: "cat input.txt",
			commandActions: [],
			status: "completed",
			aggregatedOutput: "actual\n",
		};
		expect(
			codexReturnedInput(
				ws.projectDir,
				extractCodexFootprint(item, "r")!,
				item,
			),
		).toHaveProperty("reason");
	} finally {
		await ws.cleanup();
	}
});

test("same-size changes above the hash cap remain size-only and no observation is upgraded", async () => {
	const ws = await makeTempWorkbench();
	try {
		const path = join(ws.projectDir, "large.txt");
		await writeFile(path, "a".repeat(2_000_001));
		const before = await hashPathClaim(ws.projectDir, "large.txt");
		await writeFile(path, "b".repeat(2_000_001));
		const after = await captureReturnedInput(ws.projectDir, "large.txt", {
			returned: "a",
			content: "a",
			selector: { kind: "file" },
		});
		expect(before.size).toBe(after.size);
		expect(after.version).toBeNull();
		expect(claimObservation(after).source).toBe("unknown");
	} finally {
		await ws.cleanup();
	}
});

test("unknown or mismatched receipts preserve the earlier measured premise", async () => {
	const ws = await makeTempWorkbench();
	try {
		await writeFile(join(ws.projectDir, "input.txt"), "v1");
		const before = await hashPathClaim(ws.projectDir, "input.txt");
		await writeFile(join(ws.projectDir, "input.txt"), "v2");
		for (const result of [
			{ reason: "Read 结构缺失" },
			{ returned: "v1", content: "v1", selector: { kind: "file" as const } },
		]) {
			const after = await captureReturnedInput(
				ws.projectDir,
				"input.txt",
				result,
			);
			const view = foldReadSet(
				[before, after].map((used, index) => ({
					seq: index + 1,
					timestamp: "2026-10-25",
					activity: "read",
					agent: "w",
					used: [used],
					generated: [],
					facets: { tool: "Read" },
				})),
			);
			expect(
				view.readFragments.get("input.txt")?.map((read) => read.version),
			).toEqual([hashText("v1"), hashText("v2")]);
		}
	} finally {
		await ws.cleanup();
	}
});
