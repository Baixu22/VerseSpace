import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import type { FootprintLine } from "../blackboard/session-types";
import { foldReadSet } from "../blackboard/session-view";
import { writerSpoolDir } from "../blackboard/sessions";
import { inheritParentFootprint } from "../chat/thread-inheritance";
import { makeTempWorkbench } from "../test/fixtures";
import { diffFor } from "./premise-diff";
import { currentPremiseNotices, reconcilePremises } from "./premises";
import { diffReadSet } from "./read-set-diff";

function line(
	seq: number,
	version: string | null,
	start = 1,
	end = 2,
): FootprintLine {
	return {
		seq,
		timestamp: "2026-09-30",
		activity: `read-${seq}`,
		agent: "w",
		used: [{ path: "a.txt", version, span: { start, end } }],
		generated: [],
		facets: { tool: "Read" },
	};
}

test("versioned ranges retain disjoint inputs, refresh exact ranges, and respect the fork boundary", () => {
	const lines = [line(1, "v1"), line(2, "v2", 9, 10), line(3, "v3")];
	expect(
		foldReadSet(lines, 2)
			.readFragments.get("a.txt")
			?.map((r) => r.version),
	).toEqual(["v1", "v2"]);
	expect(
		foldReadSet(lines)
			.readFragments.get("a.txt")
			?.map((r) => r.version),
	).toEqual(["v2", "v3"]);
	expect(
		foldReadSet([...lines, line(4, null)]).readFragments.get("a.txt"),
	).toHaveLength(3);
	expect(
		foldReadSet([
			...lines,
			line(4, "v4", 1, Number.MAX_SAFE_INTEGER),
		]).readFragments.get("a.txt"),
	).toHaveLength(1);
	// A wider range in another version is not proof that the old source range
	// was reread (line coordinates may have shifted).
	expect(
		foldReadSet([line(1, "v1"), line(2, "v2", 1, 5)]).readFragments.get(
			"a.txt",
		),
	).toHaveLength(2);
});

test("multiple reads do not lose the first span or count the unread gap as read; restore cites the affected read", async () => {
	const ws = await makeTempWorkbench();
	try {
		const rows = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
		const file = join(ws.projectDir, "a.txt");
		await writeFile(file, rows.join("\n"));
		await ws.bb.sessions.register("w", "agent");
		for (const [start, end] of [
			[1, 2],
			[9, 10],
		]) {
			await ws.bb.sessions.recordActivity("w", {
				activity: `read-${start}`,
				agent: "w",
				generated: [],
				facets: { tool: "Read" },
				used: [
					await hashPathClaim(
						ws.projectDir,
						"a.txt",
						writerSpoolDir(ws.bb.paths, "w"),
						{ start: start!, end: end! },
					),
				],
			});
		}
		rows[5] = "unread gap changed";
		await writeFile(file, rows.join("\n"));
		expect(await reconcilePremises(ws.bb)).toHaveLength(0);
		rows[0] = "first read changed";
		await writeFile(file, rows.join("\n"));
		expect(
			(await reconcilePremises(ws.bb))[0]?.stale.map((r) => r.path),
		).toEqual(["a.txt"]);
		const restored = await diffReadSet(ws.bb, "w", { footprintSeq: 2 });
		expect(restored.compared).toBe(1);
		expect(restored.comparable).toBe(1);
		expect(restored.stale).toHaveLength(1);
		expect(restored.stale[0]?.observedFootprintSeq).toBe(1);
		expect(restored.stale[0]?.refs).toContain(
			`footprint:${(await ws.bb.sessions.footprint("w"))[0]?.eventId}`,
		);
		// A new version of the other range must not clear the stale first range.
		await ws.bb.sessions.recordActivity("w", {
			activity: "reread-second",
			agent: "w",
			generated: [],
			used: [
				await hashPathClaim(
					ws.projectDir,
					"a.txt",
					writerSpoolDir(ws.bb.paths, "w"),
					{ start: 9, end: 10 },
				),
			],
		});
		expect(await currentPremiseNotices(ws.bb, "w")).toHaveLength(1);
		await ws.bb.sessions.recordActivity("w", {
			activity: "reread-first",
			agent: "w",
			generated: [],
			used: [
				await hashPathClaim(ws.projectDir, "a.txt", undefined, {
					start: 1,
					end: 2,
				}),
			],
		});
		expect(await currentPremiseNotices(ws.bb, "w")).toHaveLength(0);
	} finally {
		await ws.cleanup();
	}
});

test("a newer or mismatched snapshot cannot stand in for an older observation", async () => {
	const ws = await makeTempWorkbench();
	try {
		const file = join(ws.projectDir, "a.txt");
		const spool = writerSpoolDir(ws.bb.paths, "w");
		await writeFile(file, "first version");
		const first = await hashPathClaim(ws.projectDir, "a.txt", spool);
		await writeFile(file, "second version");
		const second = await hashPathClaim(ws.projectDir, "a.txt", spool);
		expect(first.spool).not.toBe(second.spool);
		expect(await diffFor(ws.bb, "w", first)).toContain("-first version");
		expect(
			await diffFor(ws.bb, "w", { ...first, spool: second.spool }),
		).toBeUndefined();
	} finally {
		await ws.cleanup();
	}
});

test("fork inheritance keeps every versioned range at its source boundary", async () => {
	const ws = await makeTempWorkbench();
	try {
		await ws.bb.sessions.register("parent", "agent");
		await ws.bb.sessions.register("child", "agent");
		for (const record of [
			line(1, "v1"),
			line(2, "v2", 9, 10),
			line(3, "v3", 1, Number.MAX_SAFE_INTEGER),
		]) {
			await ws.bb.sessions.recordActivity("parent", record);
		}
		const inherited = await inheritParentFootprint({ bb: ws.bb }, "child", {
			provider: "claude",
			mode: "fork-session",
			sourceThreadId: "parent",
			sourceSessionId: "parent",
			sourceFootprintSeq: 2,
		});
		expect(inherited.refs).toHaveLength(2);
		const fragments = (
			await ws.bb.sessions.readSetView("child")
		).readFragments.get("a.txt");
		expect(fragments?.map((r) => r.version)).toEqual(["v1", "v2"]);
		expect(fragments?.map((r) => r.span?.start)).toEqual([1, 9]);
	} finally {
		await ws.cleanup();
	}
});

test("size-only rereads refresh size observations but cannot erase a hashed observation", () => {
	const first = line(1, null, 1, Number.MAX_SAFE_INTEGER);
	first.used[0]!.size = 2_000_001;
	const second = line(2, null, 1, Number.MAX_SAFE_INTEGER);
	second.used[0]!.size = 2_000_002;
	expect(foldReadSet([first, second]).readFragments.get("a.txt")).toHaveLength(
		1,
	);
	expect(
		foldReadSet([line(1, "hash"), second]).readFragments.get("a.txt"),
	).toHaveLength(2);
});
