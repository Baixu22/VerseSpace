import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { makeTempWorkbench } from "../test/fixtures";
import { collectInterest, lowerInterest } from "./context";
import { computeDoi } from "./doi";
import { projectLandmarks } from "./project";
import type { InteractionEvent } from "./types";

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
