import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { landmarkCandidates } from "../../src/interactions/landmark-set";
import { reviewLandmark } from "../../src/interactions/review";
import { currentLandmarkAcceptance } from "../../src/interactions/review-stats";
import { makeTempWorkbench } from "../../src/test/fixtures";

/**
 * TF-0057 L1 口径隔离：steward 自审是真实数据，但绝不能抬升 human 口径。
 *
 * 走库内 API，而不是再 spawn 一层 bun 跑 CLI——CI runner 上
 * `spawnSync(bun.exe)` 会立刻 ETIMEDOUT（嵌套 bun + 实时扫描/进程配额），
 * 那测的是宿主 spawn 能力，不是复核口径。CLI 与本测试共用
 * `reviewLandmark` + `currentLandmarkAcceptance` 同一实现。
 */
test("代理自审不能宣称 L1 真人验收达标，真实人答通道单独计数", async () => {
	const ws = await makeTempWorkbench();
	try {
		await mkdir(join(ws.projectDir, "src"));
		await writeFile(
			join(ws.projectDir, "src/core.ts"),
			"export const core = 1;\n",
		);
		await ws.bb.sessions.register("writer", "agent", "测试会话");
		await ws.bb.sessions.recordActivity("writer", {
			activity: "edit-core",
			agent: "writer",
			used: [],
			generated: [{ path: "src/core.ts" }],
		});

		const events = await ws.bb.events.all();
		const candidates = landmarkCandidates(events, "writer", {
			denominator: "session-top-k",
		});
		expect(candidates.length).toBeGreaterThan(0);
		const handle = candidates[0]!;
		const writerRefs = [{ id: "writer", kind: "agent" as const }];

		await reviewLandmark(ws.bb, "writer", handle, "endorse", undefined, {
			source: "steward",
		});
		const afterSteward = await ws.bb.events.all();
		const stewardJudgement = currentLandmarkAcceptance(
			afterSteward,
			writerRefs,
			Date.now(),
			"steward",
			{ denominator: "session-top-k" },
		);
		const humanAfterSteward = currentLandmarkAcceptance(
			afterSteward,
			writerRefs,
			Date.now(),
			"human",
			{ denominator: "session-top-k" },
		);
		expect(stewardJudgement.reviewed).toBeGreaterThan(0);
		expect(stewardJudgement.endorsed).toBeGreaterThan(0);
		// human 口径仍然空：自审不得冒充用户认可
		expect(humanAfterSteward.reviewed).toBe(0);
		expect(humanAfterSteward.endorsed).toBe(0);
		expect(
			await ws.bb.events.query({
				source: "human",
				type: "landmark.reviewed",
			}),
		).toHaveLength(0);

		await reviewLandmark(ws.bb, "writer", handle, "endorse", undefined, {
			source: "human",
		});
		const afterHuman = await ws.bb.events.all();
		const humanJudgement = currentLandmarkAcceptance(
			afterHuman,
			writerRefs,
			Date.now(),
			"human",
			{ denominator: "session-top-k" },
		);
		expect(humanJudgement.reviewed).toBeGreaterThan(0);
		expect(humanJudgement.endorsed).toBeGreaterThan(0);
		expect(
			await ws.bb.events.query({
				source: "human",
				type: "landmark.reviewed",
			}),
		).toHaveLength(1);
	} finally {
		await ws.cleanup();
	}
});
