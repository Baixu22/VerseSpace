import { describe, expect, test } from "bun:test";
import { buildProgram } from "./cli";

describe("buildProgram", () => {
	test("exposes the scaffolded top-level command tree", () => {
		const names = buildProgram().commands.map((command) => command.name());
		expect(names).toEqual([
			"init",
			"goal",
			"decision",
			"interface",
			"agent",
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

	test("global flags include --json and --quiet", () => {
		const longFlags = buildProgram().options.map((option) => option.long);
		expect(longFlags).toContain("--json");
		expect(longFlags).toContain("--quiet");
	});
});
