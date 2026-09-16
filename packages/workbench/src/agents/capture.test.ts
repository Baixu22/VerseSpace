import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashText } from "../hash";
import { makeTempWorkbench, type TempWorkbench } from "../test/fixtures";
import { readLatestSession, startAgent } from "./runner";

describe("agent stream capture", () => {
	let ws: TempWorkbench;
	let worktree: string;

	beforeEach(async () => {
		ws = await makeTempWorkbench();
		worktree = join(ws.projectDir, "worktrees", "agent space");
		await mkdir(join(worktree, "src"), { recursive: true });
		await ws.bb.state.workspots.save({
			id: "ws-capture",
			branch: "capture",
			worktreePath: worktree,
			primaryTask: "capture-goal",
			binding: "primary",
			status: "active",
			contextNeeds: { decisions: [], interfaces: [] },
		});
	});

	afterEach(async () => {
		await ws.cleanup();
	});

	async function run(script: string) {
		const file = join(worktree, "agent.mjs");
		await writeFile(
			file,
			[
				'import { readFile, writeFile } from "node:fs/promises";',
				"const emit = (event) => console.log(JSON.stringify(event));",
				'emit({type:"system",subtype:"init"});',
				'if ((await Bun.stdin.text()) !== "capture prompt") throw new Error("stdin lost");',
				script,
			].join("\n"),
		);
		const config = await ws.bb.config.load();
		config.agent.command = `"${process.execPath}" "${file}"`;
		await ws.bb.config.save(config);
		expect(
			(
				await startAgent(ws.bb, {
					workspotId: "ws-capture",
					prompt: "capture prompt",
				})
			).ok,
		).toBe(true);
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const session = await readLatestSession(ws.bb, "ws-capture");
			if (session && session.status !== "running") return session;
			await Bun.sleep(20);
		}
		throw new Error("agent did not finish");
	}

	test.each([
		{ is_error: true, result: "model request failed" },
		{ subtype: "error_during_execution", result: "tool budget exhausted" },
	])("a failed result is failed even when the process exits zero: %j", async (result) => {
		const session = await run(
			`emit(${JSON.stringify({ type: "result", ...result })});`,
		);
		expect(session.exitCode).toBe(0);
		expect(session.status).toBe("failed");
		expect(session.error).toContain(result.result);
		const finished = await ws.bb.events.query({ type: "agent_finished" });
		expect(finished[0]?.payload).toMatchObject({ status: "failed" });
	});

	test("captures every tool block and resolves relative claims in the worktree", async () => {
		await mkdir(join(ws.projectDir, "src"));
		await writeFile(
			join(ws.projectDir, "src", "input.ts"),
			"parent checkout\n",
		);
		await writeFile(join(worktree, "src", "input.ts"), "worktree input\n");
		await writeFile(join(worktree, "src", "other.ts"), "other input\n");
		const session = await run(`
			await readFile("src/input.ts", "utf8");
			await readFile("src/other.ts", "utf8");
			emit({type:"assistant", message:{content:[
				{type:"tool_use", id:"read-1", name:"Read", input:{file_path:"src/input.ts"}},
				{type:"tool_use", id:"read-2", name:"Read", input:{file_path:"src/other.ts"}}
			]}});
			emit({type:"user", message:{content:[
				{type:"tool_result", tool_use_id:"read-1", content:"worktree input\\n"},
				{type:"tool_result", tool_use_id:"read-2", content:"other input\\n"}
			]}});
			await writeFile("src/output.ts", "generated output\\n");
			emit({type:"assistant", message:{content:[
				{type:"tool_use", id:"write-1", name:"Write", input:{file_path:"src/output.ts"}}
			]}});
			emit({type:"user", message:{content:[
				{type:"tool_result", tool_use_id:"write-1", content:"written"}
			]}});
			emit({type:"result", subtype:"success"});
		`);
		expect(session.status).toBe("done");
		const footprint = await ws.bb.sessions.footprint("agent:ws-capture");
		expect(footprint.map((line) => line.activity)).toEqual([
			"read-1",
			"read-2",
			"write-1",
		]);
		expect(footprint[0]?.used[0]).toMatchObject({
			path: "worktrees/agent space/src/input.ts",
			version: hashText("worktree input\n"),
		});
		expect(footprint[1]?.used[0]).toMatchObject({
			path: "worktrees/agent space/src/other.ts",
			version: hashText("other input\n"),
		});
		expect(footprint[2]?.generated[0]).toMatchObject({
			path: "worktrees/agent space/src/output.ts",
			version: hashText("generated output\n"),
		});
		expect((await ws.bb.sessions.get("agent:ws-capture"))?.kind).toBe("agent");
	});

	test("rejected tools do not become successful read or write claims", async () => {
		await writeFile(join(worktree, "src", "input.ts"), "unchanged\n");
		await run(`
			for (const [id, name] of [["denied-read", "Read"], ["denied-write", "Write"]]) {
				emit({type:"assistant", message:{content:[
					{type:"tool_use", id, name, input:{file_path:"src/input.ts"}}
				]}});
				emit({type:"user", message:{content:[
					{type:"tool_result", tool_use_id:id, is_error:true, content:"permission denied"}
				]}});
			}
			emit({type:"result", subtype:"success"});
		`);
		expect(await ws.bb.sessions.footprint("agent:ws-capture")).toEqual([]);
	});

	test.each([
		"model-error",
		"truncated",
	])("unexecuted tools remain unobserved after %s", async (ending) => {
		await writeFile(
			join(worktree, "src", "input.ts"),
			"never read by the agent\n",
		);
		const session = await run(`
			emit({type:"assistant",message:{content:[
				{type:"tool_use",id:"pending-read",name:"Read",input:{file_path:"src/input.ts"}},
				{type:"tool_use",id:"pending-write",name:"Write",input:{file_path:"src/absent.ts"}}
			]}});
			${ending === "model-error" ? 'emit({type:"result",is_error:true,result:"aborted before tools"});' : "process.exit(1);"}
		`);
		expect(session.status).toBe("failed");
		expect(await ws.bb.sessions.footprint("agent:ws-capture")).toEqual([]);
		expect(await Bun.file(join(worktree, "src", "absent.ts")).exists()).toBe(
			false,
		);
	});

	test("a footprint persistence error finishes failed instead of leaving an unhandled rejection", async () => {
		const record = spyOn(ws.bb.sessions, "recordActivity").mockRejectedValue(
			new Error("footprint disk full"),
		);
		try {
			const session = await run(`
				emit({type:"assistant", message:{content:[
					{type:"tool_use", id:"read", name:"Read", input:{file_path:"src/input.ts"}}
				]}});
				emit({type:"user", message:{content:[
					{type:"tool_result", tool_use_id:"read", content:"data"}
				]}});
				emit({type:"result", subtype:"success"});
			`);
			expect(session.status).toBe("failed");
			expect(session.error).toContain("footprint disk full");
		} finally {
			record.mockRestore();
		}
	});
});
