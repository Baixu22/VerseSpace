import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { makeTempWorkbench, type TempWorkbench } from "../test/fixtures";
import { startAgent } from "./runner";

async function seed(ws: TempWorkbench) {
	const file = join(ws.projectDir, "actor.mjs");
	await writeFile(
		file,
		`console.log(JSON.stringify({type:"system",subtype:"init"}));
await Bun.stdin.text(); await Bun.sleep(700);
console.log(JSON.stringify({type:"result",subtype:"success"}));`,
	);
	await ws.bb.state.workspots.save({
		id: "ws",
		branch: "audit",
		worktreePath: ws.projectDir,
		primaryTask: "goal",
		binding: "primary",
		status: "active",
		contextNeeds: { decisions: [], interfaces: [] },
	});
	const config = await ws.bb.config.load();
	config.agent.command = `"${process.execPath}" "${file}"`;
	await ws.bb.config.save(config);
}

test("only one concurrent batch can own a workspot in one process", async () => {
	const ws = await makeTempWorkbench();
	try {
		await seed(ws);
		const results = await Promise.all(
			[1, 2].map((i) =>
				startAgent(ws.bb, { workspotId: "ws", prompt: `run-${i}` }),
			),
		);
		const started = results.filter((result) => result.ok).length;
		const deadline = Date.now() + 6000;
		while (
			(await ws.bb.events.query({ type: "agent_finished" })).length < started &&
			Date.now() < deadline
		)
			await Bun.sleep(25);
		await Bun.sleep(25);
		expect(started).toBe(1);
		expect(results.find((result) => !result.ok)?.reason).toContain("运行");
	} finally {
		await ws.cleanup();
	}
});

test("CLI processes cannot start two batches in the same workspot", async () => {
	const ws = await makeTempWorkbench();
	try {
		await seed(ws);
		const command = [
			process.execPath,
			resolve(import.meta.dir, "../index.ts"),
			"--json",
			"agent",
			"run",
			"--workspot",
			"ws",
			"--prompt",
			"concurrent",
		];
		const first = Bun.spawn(command, {
			cwd: ws.projectDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const second = Bun.spawn(command, {
			cwd: ws.projectDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exits = await Promise.all([first.exited, second.exited]);
		expect(exits.sort()).toEqual([0, 1]);
		expect(await ws.bb.events.query({ type: "agent_started" })).toHaveLength(1);
		expect(await ws.bb.events.query({ type: "agent_finished" })).toHaveLength(
			1,
		);
	} finally {
		await ws.cleanup();
	}
});
