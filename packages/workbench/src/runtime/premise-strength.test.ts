import { expect, test } from "bun:test";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claimStrength } from "../blackboard/claim-version";
import { hashPathClaim } from "../blackboard/footprint";
import { writerSpoolDir } from "../blackboard/sessions";
import { makeTempWorkbench } from "../test/fixtures";
import { currentPremiseNotices } from "./premises";
import { diffReadSet } from "./read-set-diff";

test("same-size large rewrite remains size-only, while unknown tools have no content evidence", async () => {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.sessions.register("w", "agent");
		await writeFile(join(ws.projectDir, "large.txt"), "a".repeat(2_000_001));
		const claim = await hashPathClaim(ws.projectDir, "large.txt");
		expect(claimStrength(claim)).toBe("size-only");
		await ws.bb.sessions.recordActivity("w", {
			activity: "read",
			agent: "w",
			used: [claim, { path: "unknown.txt", version: null }],
			generated: [],
			facets: { tool: "UnknownTool" },
		});
		await writeFile(join(ws.projectDir, "large.txt"), "b".repeat(2_000_001));
		const diff = await diffReadSet(ws.bb, "w", { footprintSeq: 1 });
		expect(diff.stale).toHaveLength(0); // accepted blind spot, not successful change detection
		expect(diff.strength).toEqual({
			"content-hash": 0,
			"size-only": 1,
			unknown: 1,
		});
		expect(diff.uncoveredTools).toEqual(["UnknownTool"]);
	} finally {
		await ws.cleanup();
	}
});

test("snapshot eviction preserves old premise and falls back to conservative invalidation", async () => {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.sessions.register("w", "agent");
		const spool = writerSpoolDir(ws.bb.paths, "w");
		await writeFile(join(ws.projectDir, "a.txt"), "old");
		const first = await hashPathClaim(ws.projectDir, "a.txt", spool, {
			start: 1,
			end: 1,
		});
		await ws.bb.sessions.recordActivity("w", {
			activity: "first",
			agent: "w",
			used: [first],
			generated: [],
		});
		for (let i = 0; i < 22; i++) {
			await writeFile(join(ws.projectDir, "other.txt"), `other-${i}`);
			await hashPathClaim(ws.projectDir, "other.txt", spool);
		}
		expect(
			await access(join(spool, first.spool!)).then(
				() => true,
				() => false,
			),
		).toBe(false);
		await writeFile(join(ws.projectDir, "a.txt"), "new");
		expect(
			(await ws.bb.sessions.readSetView("w")).readFragments.get("a.txt"),
		).toHaveLength(1);
		expect(await currentPremiseNotices(ws.bb, "w")).toHaveLength(1);
	} finally {
		await ws.cleanup();
	}
});
