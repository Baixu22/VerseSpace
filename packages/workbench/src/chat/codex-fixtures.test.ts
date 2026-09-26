import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { replayCodexFixture } from "../test/codex-fixture-replay";

// 夹具于 2026-09-21 随存量退役轮从 `src-tauri/tests/fixtures/streams/codex/`
// 迁入本包（ADR-0015）；本测试是第二个可观测 provider 的协议门禁（TF-0248），
// 钉住 codex app-server 归一化流 → 规范 render 决策 + 足迹的翻译层。
// 第 12 个（`write-turn-0.158.jsonl`）是 2026-09-27 的真实 0.158 写回合抓取，
// 写侧读数由 `codex-write-capture.test.ts` 单独钉住。
const FIXTURE_DIR = join(import.meta.dir, "fixtures/streams/codex");

describe("Codex stream fixtures (TF-0248)", () => {
	test("every retained codex fixture has explicit decisions and matching wire projections", async () => {
		const names = (await readdir(FIXTURE_DIR))
			.filter((name) => name.endsWith(".jsonl"))
			.sort();
		expect(names).toHaveLength(12);
		const snapshots = [];
		for (const name of names) {
			const lines = (await readFile(join(FIXTURE_DIR, name), "utf8"))
				.split(/\r?\n/)
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const replay = replayCodexFixture(name, lines);
			const { snapshot, projected, message } = replay;

			// (1) No unmodeled event shape — the whole point of an explicit table.
			expect(snapshot.undecidedKeys, `${name} has an unmodeled event`).toEqual(
				[],
			);
			expect(snapshot.decisionDistribution.undecided).toBe(0);
			// Every line got exactly one decision.
			expect(
				Object.values(snapshot.decisionDistribution).reduce((a, b) => a + b, 0),
			).toBe(lines.length);

			// (2) Preserve the authoritative assistant text: the final projected
			// message equals the concatenation of completed agentMessage `text`
			// fields for the MAIN thread (sub-agent threads render their own tools
			// but their text is not folded into the main answer).
			expect(
				projected.optimized,
				`${name}: optimized projection == final`,
			).toEqual(message);
			expect(
				projected.baseline,
				`${name}: baseline projection == final`,
			).toEqual(message);

			snapshots.push(snapshot);
		}

		// Aggregate: at least one fixture streams multiple deltas, and at least one
		// carries a command footprint — otherwise the gate proves nothing.
		expect(snapshots.some((s) => s.deltaCount > 1)).toBe(true);
		expect(snapshots.some((s) => s.footprints.length > 0)).toBe(true);

		expect(
			snapshots.map((s) => ({
				name: s.name,
				events: s.eventCount,
				deltas: s.deltaCount,
				decisions: s.decisionDistribution,
				footprints: s.footprints.length,
			})),
		).toMatchSnapshot("codex decision + footprint aggregate");
		for (const snapshot of snapshots) {
			expect(snapshot).toMatchSnapshot(snapshot.name);
		}
	});

	test("command-with-delta: structured commandActions[].path becomes a read footprint", async () => {
		const lines = (
			await readFile(join(FIXTURE_DIR, "command-with-delta.jsonl"), "utf8")
		)
			.split(/\r?\n/)
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const replay = replayCodexFixture("command-with-delta", lines);
		// The `cat package.json` command reported a structured read action.
		const reads = replay.snapshot.footprints.flatMap((fp) => fp.used);
		expect(reads).toContain("$DUMMY_REPO/package.json");
		// The command surfaces as a tool-call part the client can render.
		expect(replay.toolCallIds.length).toBeGreaterThan(0);
		// The assistant's final answer text is preserved verbatim.
		expect(replay.message.text).toContain(
			"`package.json` contains three scripts",
		);
	});

	test("turn-failed: a failed turn becomes a visible error, no phantom text", async () => {
		const lines = (
			await readFile(join(FIXTURE_DIR, "turn-failed.jsonl"), "utf8")
		)
			.split(/\r?\n/)
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const replay = replayCodexFixture("turn-failed", lines);
		expect(replay.snapshot.decisionDistribution.error).toBeGreaterThan(0);
		expect(replay.snapshot.undecidedKeys).toEqual([]);
	});
});
