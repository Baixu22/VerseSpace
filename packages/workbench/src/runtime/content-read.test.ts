import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { writerSpoolDir } from "../blackboard/sessions";
import { makeTempWorkbench } from "../test/fixtures";
import { reconcilePremises } from "./premises";

test("whole-file review and inherited reads detect body-only changes without changing old logs", async () => {
	const ws = await makeTempWorkbench();
	try {
		await mkdir(join(ws.projectDir, "src"));
		await writeFile(
			join(ws.projectDir, "src/value.ts"),
			"export function value(): number {\n  return 1;\n}\n",
		);
		await ws.bb.sessions.register("reader", "agent", "只读复核者");
		const used = await hashPathClaim(
			ws.projectDir,
			"src/value.ts",
			writerSpoolDir(ws.bb.paths, "reader"),
		);
		await ws.bb.sessions.recordActivity("reader", {
			activity: "read",
			agent: "reader",
			used: [used],
			generated: [],
			facets: { tool: "Read" },
		});
		const view = await ws.bb.sessions.readSetView("reader");
		expect(view.reads.get("src/value.ts")?.span).toEqual({
			start: 1,
			end: Number.MAX_SAFE_INTEGER,
		});
		expect(
			(await ws.bb.sessions.footprint("reader"))[0]?.used[0]?.span,
		).toBeUndefined();
		await ws.bb.sessions.register("child", "agent", "继承上下文");
		const {
			seq: _seq,
			spool: _spool,
			...inherited
		} = view.reads.get("src/value.ts")!;
		await ws.bb.sessions.recordActivity("child", {
			activity: "inherit",
			agent: "child",
			used: [inherited],
			generated: [],
			facets: { tool: "inherited" },
		});
		await writeFile(
			join(ws.projectDir, "src/value.ts"),
			"export function value(): number {\n  return 2;\n}\n",
		);
		expect(
			(await reconcilePremises(ws.bb)).map((notice) => notice.writerId).sort(),
		).toEqual(["child", "reader"]);
		await ws.bb.sessions.recordActivity("reader", {
			activity: "repair",
			agent: "reader",
			used: [await hashPathClaim(ws.projectDir, "src/value.ts")],
			generated: [],
			facets: { tool: "Read" },
		});
		expect(
			(await reconcilePremises(ws.bb)).some(
				(notice) => notice.writerId === "reader",
			),
		).toBe(false);
	} finally {
		await ws.cleanup();
	}
});
