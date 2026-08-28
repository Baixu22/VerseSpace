import { describe, expect, test } from "bun:test";
import { makeTempWorkbench } from "../test/fixtures";

describe("decisions blackboard API", () => {
	test("add persists and list returns chronological order", async () => {
		const { bb, cleanup } = await makeTempWorkbench();
		try {
			const first = await bb.decisions.add({
				title: "使用 Bun",
				rationale: "分发与工具链",
				author: "human",
				timestamp: "2026-08-28T00:00:00.000Z",
			});
			const second = await bb.decisions.add({
				title: "自研核心",
				rationale: "无整体基座",
				author: "human",
				timestamp: "2026-08-28T01:00:00.000Z",
			});
			expect(first.id).toStartWith("d-");
			const listed = await bb.decisions.list();
			expect(listed.map((d) => d.id)).toEqual([first.id, second.id]);
		} finally {
			await cleanup();
		}
	});
});
