import type { Command } from "commander";

import { decisionAdd } from "../commands/decision";

import { goalAdd, goalCancel, goalList, goalShow } from "../commands/goal";
import { initCommand } from "../commands/init";

import {
	interfaceCheck,
	interfaceList,
	interfaceRegister,
} from "../commands/interface";

import type { GlobalOptions } from "../output";

export function registerFoundation(program: Command): void {
	program
		.command("init")
		.description("initialize the .workbench/ directory")
		.option("--project <dir>", "project root to initialize in", ".")
		.action(async (options: { project: string }, command: Command) => {
			await initCommand(
				options.project,
				command.optsWithGlobals() as GlobalOptions,
			);
		});

	const goal = program.command("goal").description("manage goals");

	goal
		.command("add <title>")
		.description("add a goal (--depends-on g1,g2, repeatable --acceptance)")
		.option(
			"--depends-on <ids>",
			"comma-separated goal ids this goal depends on",
		)
		.option(
			"--acceptance <assertion>",
			"acceptance criterion (repeatable)",
			(v: string, prev: string[] = []) => [...prev, v],
		)
		.action(
			async (
				title: string,
				options: { dependsOn?: string; acceptance?: string[] },
				command: Command,
			) => {
				await goalAdd(title, options, command);
			},
		);

	goal
		.command("list")
		.description("list all goals")
		.action((_options, command) => goalList(command));

	goal
		.command("show <id>")
		.description("show one goal in detail")
		.action((id, _options, command) => goalShow(id, command));

	goal
		.command("cancel <id>")
		.description("cancel a goal")
		.action((id, _options, command) => goalCancel(id, command));

	const decision = program
		.command("decision")
		.description("record architecture decisions");

	decision
		.command("add <title>")
		.description("add a decision (--rationale required, --author optional)")
		.option("--rationale <text>", "why this decision was made")
		.option("--author <name>", "decision author", "human")
		.action(
			async (
				title: string,
				options: { rationale?: string; author?: string },
				command: Command,
			) => {
				await decisionAdd(title, options, command);
			},
		);

	const iface = program
		.command("interface")
		.description("manage the interface registry");

	iface
		.command("register <path>")
		.description("register an interface file (--key required)")
		.option("--key <key>", "registry key, e.g. core/api")
		.action(
			async (path: string, options: { key?: string }, command: Command) => {
				await interfaceRegister(path, options, command);
			},
		);

	iface
		.command("list")
		.description("list registered interfaces")
		.action((_options, command) => interfaceList(command));

	iface
		.command("check")
		.description("check all interfaces for hash drift (exit 1 on drift)")
		.action((_options, command) => interfaceCheck(command));
}
