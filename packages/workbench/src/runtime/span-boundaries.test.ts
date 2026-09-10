import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { writerSpoolDir } from "../blackboard/sessions";
import { makeTempWorkbench } from "../test/fixtures";
import { reconcilePremises } from "./premises";

test.each([
	["末尾之后", 2, 4, 4, "inserted", 0],
	["起点之前", 2, 4, 1, "inserted", 0],
	["区间内部", 2, 4, 2, "inserted", 1],
	["内部重复起始行", 2, 4, 2, "line 2", 1],
	["单行之后", 3, 3, 3, "inserted", 0],
	["单行之前", 3, 3, 2, "inserted", 0],
] as const)("插入边界：%s", async (_label, start, end, afterLine, inserted, count) => {
	const ws = await makeTempWorkbench();
	try {
		const lines = ["line 1", "line 2", "line 3", "line 4", "line 5"];
		const file = join(ws.projectDir, "notes.txt");
		await writeFile(file, `${lines.join("\n")}\n`);
		await ws.bb.sessions.register("reader", "agent");
		const claim = await hashPathClaim(
			ws.projectDir,
			"notes.txt",
			writerSpoolDir(ws.bb.paths, "reader"),
			{ start, end },
		);
		await ws.bb.sessions.recordActivity("reader", {
			activity: "read",
			agent: "reader",
			used: [claim],
			generated: [],
		});
		lines.splice(afterLine, 0, inserted);
		await writeFile(file, `${lines.join("\n")}\n`);
		expect(await reconcilePremises(ws.bb)).toHaveLength(count);
		expect(await ws.bb.events.query({ type: "premise_stale" })).toHaveLength(
			count,
		);
	} finally {
		await ws.cleanup();
	}
});
