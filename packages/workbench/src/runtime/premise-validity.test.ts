import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hashPathClaim } from "../blackboard/footprint";
import { findMcpTool } from "../mcp/tools";
import { makeTempWorkbench } from "../test/fixtures";
import { drainPremiseQueue, pendingPremiseNotices } from "./delivery";
import { currentPremiseNotices, reconcilePremises } from "./premises";
import { decideSeal } from "./seal";

const cli = resolve(import.meta.dir, "../index.ts");

test("delivery does not resolve current validity; CLI/MCP and seals remain stale until reread", async () => {
	const ws = await makeTempWorkbench();
	try {
		await writeFile(join(ws.projectDir, "a.txt"), "old");
		await ws.bb.sessions.register("w", "agent");
		await ws.bb.sessions.recordActivity("w", {
			activity: "read",
			agent: "w",
			generated: [],
			facets: { tool: "Read" },
			used: [await hashPathClaim(ws.projectDir, "a.txt")],
		});
		await writeFile(join(ws.projectDir, "a.txt"), "new");
		expect(
			(await decideSeal(ws.bb, { writerId: "w", target: "a.txt" })).decision,
		).toBe("block");
		await reconcilePremises(ws.bb);
		await drainPremiseQueue(ws.bb, { deliver: async () => true });
		expect(await pendingPremiseNotices(ws.bb)).toHaveLength(0);
		expect(await reconcilePremises(ws.bb)).toHaveLength(0);
		expect(await currentPremiseNotices(ws.bb, "w")).toHaveLength(1);
		const before = await ws.bb.events.all();
		expect(
			await findMcpTool("premises")!.run(
				{ view: "current", writer: "w" },
				ws.bb,
			),
		).toContain("a.txt");
		expect(await ws.bb.events.all()).toHaveLength(before.length);
		const current = spawnSync(
			process.execPath,
			[cli, "premises", "current", "--writer", "w", "--json"],
			{ cwd: ws.projectDir, encoding: "utf8" },
		);
		expect(current.status).toBe(0);
		expect(JSON.parse(current.stdout).current).toHaveLength(1);
		const seal = spawnSync(
			process.execPath,
			[cli, "premises", "seal", "--writer", "w", "--target", "a.txt", "--json"],
			{ cwd: ws.projectDir, encoding: "utf8" },
		);
		expect(seal.status).toBe(2);
		expect(JSON.parse(seal.stdout).blocked).toBe(true);
		await ws.bb.sessions.recordActivity("w", {
			activity: "reread",
			agent: "w",
			generated: [],
			facets: { tool: "Read" },
			used: [await hashPathClaim(ws.projectDir, "a.txt")],
		});
		expect(
			(await decideSeal(ws.bb, { writerId: "w", target: "a.txt" })).decision,
		).toBe("pass");
	} finally {
		await ws.cleanup();
	}
});

test("an undelivered historical notice cannot block a current reread, even without another reconcile", async () => {
	const ws = await makeTempWorkbench();
	try {
		await writeFile(join(ws.projectDir, "a.txt"), "new");
		await ws.bb.sessions.register("w", "agent");
		await ws.bb.sessions.recordActivity("w", {
			activity: "old",
			agent: "w",
			generated: [],
			facets: { tool: "Read" },
			used: [{ path: "a.txt", version: "old" }],
		});
		await reconcilePremises(ws.bb);
		await ws.bb.sessions.recordActivity("w", {
			activity: "fresh",
			agent: "w",
			generated: [],
			facets: { tool: "Read" },
			used: [await hashPathClaim(ws.projectDir, "a.txt")],
		});
		expect(await pendingPremiseNotices(ws.bb)).toHaveLength(1);
		expect(await currentPremiseNotices(ws.bb, "w")).toHaveLength(0);
		expect(
			(await decideSeal(ws.bb, { writerId: "w", target: "a.txt" })).decision,
		).toBe("pass");
	} finally {
		await ws.cleanup();
	}
});
