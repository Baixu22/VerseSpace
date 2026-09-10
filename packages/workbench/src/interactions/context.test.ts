import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import type { WorkbenchEvent } from "../types/event";
import { collectInterest, interestFromEvents, lowerInterest } from "./context";
import { computeDoi } from "./doi";
import { projectLandmarks } from "./project";
import {
	INTERACTIONS_SOURCE,
	INTERACTIONS_TYPE,
	type InteractionEvent,
} from "./types";

test("TF-0110: lowering is scoped to a writer, counted, idempotent until a new touch, and exposed through the CLI", async () => {
	const ws = await makeTempWorkbench();
	try {
		for (const writer of ["a", "b"]) {
			await ws.bb.sessions.register(writer, "agent", writer);
			await ws.bb.sessions.recordActivity(writer, {
				activity: "read",
				agent: writer,
				used: [{ path: "src/a.ts" }],
				generated: [],
			});
		}
		const proc = Bun.spawn(
			[
				process.execPath,
				"run",
				resolve(import.meta.dir, "../index.ts"),
				"context",
				"lower",
				"src/a.ts",
				"--writer",
				"a",
				"--json",
			],
			{ cwd: ws.projectDir, stdout: "pipe", stderr: "pipe" },
		);
		const result = JSON.parse(await new Response(proc.stdout).text());
		expect(await proc.exited).toBe(0);
		expect(result.recorded).toBe(true);
		expect(result.eventId).toBeString();
		expect((await collectInterest(ws.bb, "a")).visible).not.toContain(
			"src/a.ts",
		);
		expect((await collectInterest(ws.bb, "b")).visible).toContain("src/a.ts");
		expect((await collectInterest(ws.bb, "a")).reductions).toMatchObject({
			total: 1,
			byHandle: { "src/a.ts": 1 },
		});
		expect((await lowerInterest(ws.bb, "a", "src/a.ts")).recorded).toBe(false);
		await expect(lowerInterest(ws.bb, "a", "unknown.ts")).rejects.toThrow(
			"没有已观察",
		);
		await ws.bb.sessions.recordActivity("a", {
			activity: "read-again",
			agent: "a",
			used: [{ path: "src/a.ts" }],
			generated: [],
		});
		expect((await collectInterest(ws.bb, "a")).visible).toContain("src/a.ts");
		expect((await collectInterest(ws.bb, "a")).reductions.total).toBe(1);
	} finally {
		await ws.cleanup();
	}
});

test("TF-0156: 地标集合按会话自己的时钟算，过了多少天再问都是同一份", () => {
	const sessionEnd = Date.parse("2026-09-01T10:00:00Z");
	const payloads: InteractionEvent[] = Array.from(
		{ length: 6 },
		(_, index) => ({
			time: new Date(sessionEnd - (5 - index) * 1000).toISOString(),
			kind: "edit" as const,
			origin: "old",
			contentType: "file" as const,
			handle: "src/alpha.ts",
			delta: 1,
		}),
	);
	const records: WorkbenchEvent[] = payloads.map((payload, index) => ({
		timestamp: payload.time,
		source: INTERACTIONS_SOURCE,
		type: INTERACTIONS_TYPE,
		payload,
		id: `probe-${index}`,
	}));
	// 6 次编辑 = 12 分（edit 权重 2），足以越过出厂 floor=10。但如果按「现在」算，
	// 衰减 0.1/小时 × 240 小时 = 24 分，分数是 12 − 24 = −12：同一段会话的地标集合
	// 会随着日期流逝自己消失，验收读数就不可复现了。判定路径显式要会话时钟。
	const askLater = Date.parse("2026-09-11T10:00:00Z");
	const atSession = interestFromEvents(records, "old", askLater, {
		clock: "session",
	});
	expect(atSession.fileLandmarkHandles).toEqual(["src/alpha.ts"]);
	expect(atSession.landmarkHandles).toContain("src/alpha.ts");
	// 再过一个月来问，还是同一份集合——判据不能被「问的时刻」改写
	expect(
		interestFromEvents(records, "old", Date.parse("2026-10-11T10:00:00Z"), {
			clock: "session",
		}).fileLandmarkHandles,
	).toEqual(atSession.fileLandmarkHandles);
	// 反过来，实时上下文那一侧保持现状：默认按「现在」算，陈旧文件按衰减离开
	// 可见集（这是有意的设计，不能被判定路径的需要顺手改掉）。
	expect(
		interestFromEvents(records, "old", askLater).fileLandmarkHandles,
	).toEqual([]);
});

test("TF-0110: a reduction does not increase touch counts or manufacture an edit", () => {
	const first = Date.parse("2026-09-06T00:00:00Z");
	const events: InteractionEvent[] = [
		{
			time: new Date(first).toISOString(),
			kind: "edit",
			origin: "a",
			contentType: "file",
			handle: "src/a.ts",
			delta: 1,
		},
		{
			time: new Date(first + 1000).toISOString(),
			kind: "interest-reduced",
			origin: "a",
			contentType: "file",
			handle: "src/a.ts",
			delta: 0,
		},
	];
	const result = computeDoi(events, first + 1000);
	const original = computeDoi(events.slice(0, 1), first + 1000);
	for (const handle of ["src", "."]) {
		expect(result.scores.get(handle)).toEqual(original.scores.get(handle));
	}
	const score = result.scores.get("src/a.ts")!;
	expect(score.visible).toBe(false);
	expect(score.touchCount).toBe(1);
	const projected = projectLandmarks(original, events);
	const file = projected.find((row) => row.handle === "src/a.ts")!;
	expect(file.editCount).toBe(1);
	expect(file.lastTouchAt).toBe(events[0]!.time);
});
