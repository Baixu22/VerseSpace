import { describe, expect, test } from "bun:test";
import { buildProgram } from "./cli";
import { makeTempWorkbench } from "./test/fixtures";

describe("buildProgram", () => {
	test("exposes the scaffolded top-level command tree", () => {
		const names = buildProgram().commands.map((command) => command.name());
		expect(names).toEqual([
			"init",
			"goal",
			"decision",
			"interface",
			"agent",
			"sessions",
			"premises",
			// R3: the human channel, the flow limit, and the lane meters
			"tribunal",
			"wip",
			"metrics",
			"stats",
			"ws",
			"checkpoint",
			"dispatch",
			"queue",
			"status",
			"map",
			"log",
			"sync",
			"watch",
			"doctor",
			"ui",
			"config",
			"context",
		]);
	});

	test("goal subtree exposes its subcommands", () => {
		const goal = buildProgram().commands.find(
			(command) => command.name() === "goal",
		);
		if (!goal) {
			throw new Error("goal command is missing");
		}
		expect(goal.commands.map((command) => command.name())).toEqual([
			"add",
			"list",
			"show",
			"cancel",
		]);
	});

	test("premises subtree exposes inspection and the seal hook", () => {
		const premises = buildProgram().commands.find(
			(command) => command.name() === "premises",
		);
		if (!premises) {
			throw new Error("premises command is missing");
		}
		expect(premises.commands.map((command) => command.name())).toEqual([
			"pending",
			"seal",
			"review-seal",
		]);
		const seal = premises.commands.find((command) => command.name() === "seal");
		expect(seal?.options.map((option) => option.long)).toEqual([
			"--writer",
			"--target",
			"--mode",
		]);
	});

	test("context subtree exposes inspection, lowering and landmark review", () => {
		const context = buildProgram().commands.find(
			(command) => command.name() === "context",
		);
		if (!context) {
			throw new Error("context command is missing");
		}
		expect(context.commands.map((command) => command.name())).toEqual([
			"list",
			"lower",
			"review",
		]);
	});

	test("tribunal subtree exposes the queue's four verbs and its numbers", () => {
		const tribunal = buildProgram().commands.find(
			(command) => command.name() === "tribunal",
		);
		if (!tribunal) {
			throw new Error("tribunal command is missing");
		}
		expect(tribunal.commands.map((command) => command.name())).toEqual([
			"list",
			"show",
			"shelve",
			"resolve",
			"stats",
		]);
	});

	test("dispatch exposes the CONWIP override as an explicit flag", () => {
		const dispatch = buildProgram().commands.find(
			(command) => command.name() === "dispatch",
		);
		expect(dispatch?.options.map((option) => option.long)).toContain("--force");
	});

	test("global flags include --json and --quiet", () => {
		const longFlags = buildProgram().options.map((option) => option.long);
		expect(longFlags).toContain("--json");
		expect(longFlags).toContain("--quiet");
	});
});

// The shape tests above only see the command tree. A command whose action
// arity does not match its operand count registers fine and crashes at call
// time, so the verbs that matter are executed through the real argv path.
describe("argv execution", () => {
	const argv = (args: string[]): string[] => ["node", "workbench", ...args];

	test("tribunal verbs run through parseAsync", async () => {
		const ws = await makeTempWorkbench();
		const cwd = process.cwd();
		process.chdir(ws.projectDir);
		try {
			const submitted = await ws.bb.tribunal.submit({
				kind: "workspot_blocked",
				subject: "ws-a",
				causeKey: "workspot_blocked:ws-a",
				action: {
					label: "重新指派工位",
					command: "workbench ws reassign ws-a --task g-2",
				},
				sbar: {
					situation: "工位 ws-a 被阻塞",
					background: "任务 g-1 已进入 stale_done",
					assessment: "工位空转，本轮产出为零",
					recommendation: "把 ws-a 改派到 g-2，或关闭它",
				},
			});
			if (!submitted.admitted || !submitted.item) {
				throw new Error("fixture candidate was not admitted");
			}

			await buildProgram().parseAsync(
				argv(["tribunal", "list", "--json", "--quiet"]),
			);
			await buildProgram().parseAsync(
				argv(["tribunal", "show", submitted.item.id]),
			);

			// a deferral is the one that used to crash on action arity
			await buildProgram().parseAsync(
				argv(["tribunal", "shelve", submitted.item.id, "--minutes", "15"]),
			);
			const shelved = await ws.bb.tribunal.list({ includeResolved: true });
			expect(
				shelved.find((item) => item.id === submitted.item!.id)?.state,
			).toBe("shelved");

			await buildProgram().parseAsync(
				argv(["tribunal", "resolve", submitted.item.id]),
			);
		} finally {
			process.chdir(cwd);
			await ws.cleanup();
		}
	});

	test("ws create rejects a missing --branch at the arg parser", async () => {
		const ws = await makeTempWorkbench();
		const cwd = process.cwd();
		process.chdir(ws.projectDir);
		try {
			// commander's default is process.exit(1) on a parse error, which would
			// take the test runner down with it; exitOverride turns that into a
			// throw. Subcommands copy the callback at creation time, so it has to be
			// walked down the tree after the program is built.
			const program = buildProgram();
			const overrideExit = (cmd: Command): void => {
				cmd.exitOverride();
				cmd.commands.forEach(overrideExit);
			};
			overrideExit(program);
			await expect(
				program.parseAsync(argv(["ws", "create", "ws-a", "--task", "g-1"])),
			).rejects.toThrow(/required option '--branch/);
		} finally {
			process.chdir(cwd);
			await ws.cleanup();
		}
	});
});
