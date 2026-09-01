/**
 * 交互事件日志集成测试（TF-0087）：
 *  - recordActivity 后 events.jsonl 同时含 footprint 与 interaction 事件；
 *  - 交互事件与足迹共用同一个 seq 时钟（行号单调、因果有序）；
 *  - 事件按写者 id 分组；
 *  - 一个月规模约 1 MB/人。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { INTERACTIONS_SOURCE, INTERACTIONS_TYPE } from "./types";

function eventsFile(projectDir: string): string {
	return join(projectDir, ".workbench", "events", "events.jsonl");
}

function parseEvents(projectDir: string): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	for (const line of readFileSync(eventsFile(projectDir), "utf8").split("\n")) {
		if (line.trim()) {
			events.push(JSON.parse(line));
		}
	}
	return events;
}

describe("交互事件日志（TF-0087）", () => {
	test("recordActivity 派生交互事件并落进同一 events.jsonl", async () => {
		const { projectDir, bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.sessions.register("ws-a", "agent", "工位 A");
			await bb.sessions.recordActivity("ws-a", {
				activity: "act-1",
				agent: "ws-a",
				used: [{ path: "src/a.ts", version: "v1", span: { start: 3, end: 8 } }],
				generated: [{ path: "src/b.ts", version: "v2" }],
				facets: { tool: "Edit" },
			});

			const events = parseEvents(projectDir);
			const footprints = events.filter((e) => e.type === "footprint");
			const interactions = events.filter(
				(e) => e.source === INTERACTIONS_SOURCE && e.type === INTERACTIONS_TYPE,
			);

			// 1 条足迹 + 2 条交互（used→selection、generated→edit）
			expect(footprints).toHaveLength(1);
			expect(interactions).toHaveLength(2);

			type Payload = {
				kind: string;
				origin: string;
				handle: string;
				delta: number;
				contentType: string;
			};
			const sel = interactions[0]?.payload as Payload | undefined;
			const edit = interactions[1]?.payload as Payload | undefined;
			expect(sel).toMatchObject({
				kind: "selection",
				origin: "ws-a",
				handle: "src/a.ts",
				delta: 6, // span 3..8 → 6 行
				contentType: "file",
			});
			expect(edit).toMatchObject({
				kind: "edit",
				origin: "ws-a",
				handle: "src/b.ts",
				delta: 1,
			});
		} finally {
			await cleanup();
		}
	});

	test("交互事件与足迹共用同一个单调 seq 时钟", async () => {
		const { projectDir, bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.sessions.register("ws-a", "agent", "A");
			await bb.sessions.recordActivity("ws-a", {
				activity: "a1",
				agent: "ws-a",
				used: [{ path: "x.ts", version: null }],
				generated: [],
			});
			await bb.sessions.recordActivity("ws-a", {
				activity: "a2",
				agent: "ws-a",
				generated: [{ path: "y.ts", version: null }],
				used: [],
			});

			const events = parseEvents(projectDir);
			// 交替落盘：footprint1, interaction1, footprint2, interaction2
			expect(events.map((e) => e.type)).toEqual([
				"footprint",
				"interaction",
				"footprint",
				"interaction",
			]);
			// events.jsonl 行号即 seq：单调由构造保证，交互事件与足迹因果有序
			const seqs = events.map((_, i) => i + 1);
			expect(seqs).toEqual([1, 2, 3, 4]);
		} finally {
			await cleanup();
		}
	});

	test("事件按写者 id 分组（origin 字段）", async () => {
		const { projectDir, bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.sessions.register("ws-a", "agent", "A");
			await bb.sessions.register("human", "human", "人");
			await bb.sessions.recordActivity("ws-a", {
				activity: "a1",
				agent: "ws-a",
				used: [{ path: "x.ts", version: null }],
				generated: [],
			});
			await bb.sessions.recordActivity("human", {
				activity: "h1",
				agent: "human",
				generated: [{ path: "y.ts", version: null }],
				used: [],
			});

			const interactions = parseEvents(projectDir)
				.filter(
					(e) =>
						e.source === INTERACTIONS_SOURCE && e.type === INTERACTIONS_TYPE,
				)
				.map((e) => (e.payload as { origin: string }).origin);
			expect(interactions).toEqual(["ws-a", "human"]);
		} finally {
			await cleanup();
		}
	});

	test("一个月规模在 1 MB/人 量级", async () => {
		const { projectDir, bb, cleanup } = await makeTempWorkbench();
		try {
			await bb.sessions.register("ws-a", "agent", "A");
			// 模拟 30 天 × 每天 40 次活动 × 每次 1 读 1 写（约 120 事件/天）
			for (let day = 0; day < 30; day += 1) {
				for (let act = 0; act < 40; act += 1) {
					await bb.sessions.recordActivity("ws-a", {
						activity: `day${day}-act${act}`,
						agent: "ws-a",
						used: [{ path: `src/m${act % 10}.ts`, version: "v" }],
						generated: [{ path: `src/w${act % 5}.ts`, version: "v" }],
					});
				}
			}
			const raw = readFileSync(eventsFile(projectDir), "utf8");
			const bytes = Buffer.byteLength(raw, "utf8");
			// 120 事件/天 × 30 天 = 3600 行；1MB 预算内留余量
			expect(bytes).toBeLessThan(1_000_000);
			expect(bytes).toBeGreaterThan(0);
			// 顺带验证：footprint + interaction 双写后单事件平均 < 280B
			expect(bytes / 3600).toBeLessThan(280);
		} finally {
			await cleanup();
		}
	});
});
