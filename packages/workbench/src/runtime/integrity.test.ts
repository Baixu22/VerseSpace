import { describe, expect, test } from "bun:test";
import { readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { registryContextStore } from "../blackboard/context-store";
import { runDoctor } from "../doctor";
import { hashText } from "../hash";
import { dispatchGoal } from "../scheduler/dispatch";
import { makeTempWorkbench, type TempWorkbench } from "../test/fixtures";
import type { Checkpoint } from "../types/checkpoint";
import { runOnce } from "./index";
import { applyRollback, planRollback } from "./rollback";

async function seed(ws: TempWorkbench) {
	await writeFile(join(ws.projectDir, "api.txt"), "v1\n");
	await ws.bb.interfaces.register({
		key: "api",
		canonicalPath: "api.txt",
		version: 1,
		publishedBy: "before",
		lastModified: new Date().toISOString(),
		contentHash: hashText("v1\n"),
		subscribers: [],
	});
	const goal = await ws.bb.goals.add({ title: "接口工作" }, "in_progress");
	await ws.bb.state.workspots.save({
		id: "ws",
		branch: "audit",
		worktreePath: ws.projectDir,
		primaryTask: goal.id,
		binding: "primary",
		status: "active",
		contextNeeds: { decisions: [], interfaces: [] },
	});
	return goal;
}

function checkpoint(
	goal: string,
	effects?: Checkpoint["blackboardEffects"],
): Checkpoint {
	return {
		id: "cp",
		goal,
		workspot: "ws",
		lifecycle: "verified",
		timestamp: new Date().toISOString(),
		assertion: "接口更新",
		artifacts: [],
		unblocks: [],
		blackboardEffects: effects,
		verificationResult: { status: "passed", at: new Date().toISOString() },
	};
}

describe("integrity: completion must have applied facts", () => {
	test("executes registry updates before applied, completes next cycle, and can restore metadata", async () => {
		const ws = await makeTempWorkbench();
		try {
			const goal = await seed(ws);
			await ws.bb.checkpoints.save(
				checkpoint(goal.id, {
					publish: [],
					update: [{ key: "api", field: "publishedBy", value: "after" }],
				}),
				"verified",
			);
			await runOnce(ws.bb);
			expect((await ws.bb.interfaces.getEntry("api"))?.publishedBy).toBe(
				"after",
			);
			const applied = (await ws.bb.checkpoints.scanZone("verified"))[0]!;
			expect(applied.lifecycle).toBe("applied");
			expect((await ws.bb.goals.get(goal.id))?.status).toBe("in_progress");
			await runOnce(ws.bb);
			expect((await ws.bb.goals.get(goal.id))?.status).toBe("done");
			const store = registryContextStore(ws.bb);
			const plan = await planRollback(applied, "context", { store });
			expect((await applyRollback(plan, applied, { store })).ok).toBe(true);
			expect((await ws.bb.interfaces.getEntry("api"))?.publishedBy).toBe(
				"before",
			);
		} finally {
			await ws.cleanup();
		}
	});

	test.each([
		{ publish: [{ key: "new", type: "interface" }], update: [] },
		{ publish: [], update: [{ key: "api", field: "unknown", value: true }] },
		{
			publish: [],
			update: [
				{ key: "api", field: "publishedBy", value: "after" },
				{ key: "api", field: "canonicalPath", value: 42 },
			],
		},
	])("rejects unsupported or invalid effects without an applied claim: %j", async (effects) => {
		const ws = await makeTempWorkbench();
		try {
			const goal = await seed(ws);
			await ws.bb.checkpoints.save(
				checkpoint(goal.id, {
					publish: [...effects.publish],
					update: [...effects.update],
				}),
				"verified",
			);
			await runOnce(ws.bb);
			expect((await ws.bb.interfaces.getEntry("api"))?.publishedBy).toBe(
				"before",
			);
			expect((await ws.bb.goals.get(goal.id))?.status).toBe("in_progress");
			expect(
				await ws.bb.events.query({ type: "checkpoint_applied" }),
			).toHaveLength(0);
			const failed = (await ws.bb.checkpoints.scanZone("failed"))[0];
			expect(failed).toMatchObject({
				lifecycle: "failed",
				applicationError: expect.any(String),
			});
		} finally {
			await ws.cleanup();
		}
	});

	test("a failed checkpoint in the verified directory is not completion evidence", async () => {
		const ws = await makeTempWorkbench();
		try {
			const goal = await seed(ws);
			await ws.bb.checkpoints.save(
				{ ...checkpoint(goal.id), lifecycle: "failed" },
				"verified",
			);
			const doctor = await runDoctor(ws.bb);
			expect(doctor.ok).toBe(false);
			expect(
				doctor.issues.some(
					(issue) => issue.check === "checkpoint_zone_mismatch",
				),
			).toBe(true);
			await runOnce(ws.bb);
			expect((await ws.bb.goals.get(goal.id))?.status).toBe("in_progress");
		} finally {
			await ws.cleanup();
		}
	});
});

describe("integrity: missing and corrupt interfaces", () => {
	test("a deleted contract invalidates completion and blocks ready dependents before dispatch", async () => {
		const ws = await makeTempWorkbench();
		try {
			const parent = await seed(ws);
			await ws.bb.goals.update(parent.id, {
				status: "done",
				verifiedAgainst: { interfaces: { api: 1 }, decisions: [] },
			});
			await ws.bb.state.workspots.save({
				...(await ws.bb.state.workspots.get("ws"))!,
				status: "idle",
			});
			const planned = await ws.bb.goals.add({
				title: "计划依赖",
				dependsOn: [parent.id],
			});
			const ready = await ws.bb.goals.add(
				{ title: "已就绪依赖", dependsOn: [parent.id] },
				"ready",
			);
			await ws.bb.state.queue.enqueue(ready.id);
			await rm(join(ws.projectDir, "api.txt"));
			const dispatch = await dispatchGoal(ws.bb, ready.id, "ws");
			expect(dispatch.ok).toBe(false);
			expect(dispatch.reason).toContain("依赖");
			await runOnce(ws.bb);
			expect((await ws.bb.goals.get(parent.id))?.status).toBe("stale_done");
			expect((await ws.bb.goals.get(planned.id))?.status).toBe("planned");
			expect((await ws.bb.goals.get(ready.id))?.status).toBe("planned");
			expect(await ws.bb.state.queue.get()).not.toContain(ready.id);
		} finally {
			await ws.cleanup();
		}
	});

	test("doctor and sync reject malformed registry YAML and name its file", async () => {
		const ws = await makeTempWorkbench();
		try {
			await seed(ws);
			const filename = (await readdir(ws.bb.paths.registry))[0]!;
			await writeFile(
				join(ws.bb.paths.registry, filename),
				"key: api\nversion: [broken\n",
			);
			await expect(ws.bb.interfaces.list()).rejects.toThrow("invalid YAML");
			for (const verb of ["doctor", "sync"]) {
				const proc = Bun.spawnSync(
					[
						process.execPath,
						resolve(import.meta.dir, "../index.ts"),
						"--json",
						verb,
					],
					{ cwd: ws.projectDir },
				);
				expect(proc.exitCode).toBe(1);
				const output = new TextDecoder().decode(proc.stdout);
				expect(JSON.parse(output).ok).toBe(false);
				expect(output).toContain(filename);
			}
		} finally {
			await ws.cleanup();
		}
	});
});
