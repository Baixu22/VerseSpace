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
