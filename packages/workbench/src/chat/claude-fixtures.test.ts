import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ipcTotals, replayClaudeFixture } from "./claude-fixture-replay";
import { asRecord, contentBlocks } from "./claude-render-blocks";
import { flattenToolParts } from "./tool-collapse";

// 夹具于 2026-09-21 随存量退役轮从 `src-tauri/tests/fixtures/streams/claude/`
// 迁入本包（ADR-0015）：主线不再依赖 `src-tauri/`，参考样本留在自己身边。
const FIXTURE_DIR = join(import.meta.dir, "fixtures/streams/claude");

describe("Claude stream fixtures (TF-0206)", () => {
	test("all 19 fixtures have explicit decisions, matching wire projections and IPC savings", async () => {
		const names = (await readdir(FIXTURE_DIR))
			.filter((name) => name.endsWith(".jsonl"))
			.sort();
		expect(names).toHaveLength(19);
		const snapshots = [];
		for (const name of names) {
			const lines = (await readFile(join(FIXTURE_DIR, name), "utf8"))
				.split(/\r?\n/)
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const replay = replayClaudeFixture(name, lines);
			const { snapshot, baseline, optimized, beforeDone, projected, message } =
				replay;
			const blocks = lines
				.filter((event) => event.type === "assistant")
				.flatMap(contentBlocks)
				.map(asRecord);
			expect(message.text, `${name}: preserve all authoritative text`).toBe(
				blocks
					.filter((block) => block?.type === "text")
					.map((block) => block?.text)
					.join(""),
			);
			expect(
				flattenToolParts(message.parts).map((tool) => tool.toolCallId),
			).toEqual([
				...new Set(
					blocks
						.filter(
							(block) =>
								block?.type === "tool_use" || block?.type === "mcp_tool_use",
						)
						.map((block) => String(block?.id)),
				),
			]);
			expect(snapshot.undecidedKeys, `${name} has an unmodeled event`).toEqual(
				[],
			);
			expect(snapshot.decisionDistribution.undecided).toBe(0);
			expect(
				Object.values(snapshot.decisionDistribution).reduce((a, b) => a + b, 0),
			).toBe(lines.length);
			expect(
				beforeDone.baseline,
				`${name}: projections must agree before authoritative done`,
			).toEqual(beforeDone.optimized);
			expect(projected.baseline).toEqual(message);
			expect(projected.optimized).toEqual(message);
			expect(baseline.length).toBe(optimized.length);
			for (const [index, line] of optimized.entries()) {
				const event = JSON.parse(line);
				if (event.type !== "delta") expect(baseline[index]).toBe(line);
				expect(line.endsWith("\n")).toBe(true);
			}
			expect(snapshot.ipc.doneBytes).toBeGreaterThan(0);
			expect(snapshot.ipc.controlBytes).toBeGreaterThan(0);
			expect(snapshot).toMatchSnapshot(name);
			snapshots.push(snapshot);
		}
		const multiDelta = snapshots.filter((snapshot) => snapshot.deltaCount > 1);
		expect(multiDelta.length).toBeGreaterThan(0);
		for (const snapshot of multiDelta) {
			expect(
				snapshot.ipc.savedBytes,
				`${snapshot.name}: per-stream-delta savings`,
			).toBeGreaterThan(0);
		}
		const aggregate = {
			fixtures: snapshots.length,
			events: snapshots.reduce((sum, snapshot) => sum + snapshot.eventCount, 0),
			textDeltas: snapshots.reduce(
				(sum, snapshot) => sum + snapshot.deltaCount,
				0,
			),
			multiDeltaFixtures: multiDelta.map((snapshot) => snapshot.name),
			undecided: snapshots.reduce(
				(sum, snapshot) => sum + snapshot.decisionDistribution.undecided,
				0,
			),
			...ipcTotals(
				snapshots.reduce(
					(sum, snapshot) => sum + snapshot.ipc.baselineBytes,
					0,
				),
				snapshots.reduce(
					(sum, snapshot) => sum + snapshot.ipc.optimizedBytes,
					0,
				),
			),
		};
		expect(aggregate).toMatchSnapshot("aggregate NDJSON IPC totals");
		expect(aggregate.savedBytes).toBeGreaterThan(0);
	});

	test("comparison retains real result fallback and identical done/control overhead", () => {
		const replay = replayClaudeFixture("result-only", [
			{ type: "result", subtype: "success", result: "完整回复" },
		]);
		expect(replay.message.text).toBe("完整回复");
		expect(replay.beforeDone.baseline).toEqual(replay.beforeDone.optimized);
		expect(replay.projected.optimized).toEqual(replay.message);
		expect(replay.baseline.at(-1)).toBe(replay.optimized.at(-1));
		expect(replay.snapshot.deltaCount).toBe(1);
	});
});
