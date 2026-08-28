import { Command } from "commander";
import {
	checkpointCreate,
	checkpointList,
	checkpointReview,
} from "./commands/checkpoint";
import { configSet, queueCommand } from "./commands/config";
import { decisionAdd } from "./commands/decision";
import { dispatchCommand } from "./commands/dispatch";
import { doctorCommand } from "./commands/doctor";
import { goalAdd, goalCancel, goalList, goalShow } from "./commands/goal";
import { initCommand } from "./commands/init";
import {
	interfaceCheck,
	interfaceList,
	interfaceRegister,
} from "./commands/interface";
import {
	logCommand,
	mapCommand,
	statusCommand,
	syncCommand,
} from "./commands/sync";
import { uiCommand } from "./commands/ui";
import { watchCommand } from "./commands/watch";
import { wsCreate, wsList, wsReassign, wsStatus } from "./commands/ws";
import type { GlobalOptions } from "./output";
import { WORKBENCH_VERSION } from "./version";

export function buildProgram(): Command {
	const program = new Command();
	program
		.name("workbench")
		.description("CLI + filesystem state manager for AI-assisted development")
		.version(WORKBENCH_VERSION)
		.option("--json", "emit machine-readable JSON output")
		.option("--quiet", "suppress human-readable output");

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

	const ws = program.command("ws").description("manage workspots");
	ws.command("create <id>")
		.description(
			"create a workspot (--task goal-id, --branch, --worktree path)",
		)
		.option("--task <goal-id>", "primary goal for this workspot")
		.option("--branch <branch>", "git branch this workspot holds")
		.option("--worktree <path>", "worktree path (default worktrees/<id>)")
		.action(
			async (
				id: string,
				options: { task?: string; branch?: string; worktree?: string },
				command: Command,
			) => {
				await wsCreate(id, options, command);
			},
		);
	ws.command("list")
		.description("list workspots")
		.action((_options, command) => wsList(command));
	ws.command("reassign <id>")
		.description("reassign a workspot (--task goal-id, --temporary borrows it)")
		.option("--task <goal-id>", "new goal for this workspot")
		.option(
			"--temporary",
			"borrow the workspot instead of reassigning its primary task",
		)
		.action(
			async (
				id: string,
				options: { task?: string; temporary?: boolean },
				command: Command,
			) => {
				await wsReassign(id, options, command);
			},
		);
	ws.command("status <id>")
		.description("show one workspot")
		.action((id, _options, command) => wsStatus(id, command));

	const checkpoint = program
		.command("checkpoint")
		.description("manage checkpoints");
	checkpoint
		.command("create")
		.description(
			"drop a draft checkpoint into staging (--goal, --assertion, --workspot)",
		)
		.option("--goal <goal-id>", "goal this checkpoint belongs to")
		.option("--assertion <text>", "what this checkpoint asserts")
		.option("--workspot <id>", "workspot that produced the work")
		.option("--strategy <name>", "test | type-check | build | human-review")
		.option("--command <cmd>", "override the strategy's default command")
		.option("--timeout <seconds>", "verification timeout")
		.action(checkpointCreate);
	checkpoint
		.command("list")
		.description("list checkpoints (--staging | --verified | --failed)")
		.option("--staging", "list only the staging zone")
		.option("--verified", "list only the verified zone")
		.option("--failed", "list only the failed zone")
		.action(checkpointList);
	checkpoint
		.command("review <id>")
		.description(
			"review a checkpoint awaiting human review (--approve | --reject)",
		)
		.option("--approve", "accept the checkpoint into the verified zone")
		.option("--reject", "reject the checkpoint into the failed zone")
		.action(
			async (
				id: string,
				options: { approve?: boolean; reject?: boolean },
				command: Command,
			) => {
				await checkpointReview(id, options, command);
			},
		);

	program
		.command("dispatch <goal-id> [workspot-id]")
		.description(
			"dispatch a ready goal to an idle workspot (creates the git worktree)",
		)
		.action(
			(
				goalId: string,
				workspotId?: string,
				_options?: unknown,
				command?: Command,
			) =>
				// commander always passes declared operands + (options, command),
				// filling absent optional operands with undefined
				dispatchCommand(goalId, workspotId, command as Command),
		);
	program
		.command("queue")
		.description("show the execution queue")
		.action((_options, command) => queueCommand(command));
	program
		.command("status")
		.description("global status overview")
		.action((_options, command) => statusCommand(command));
	program
		.command("map")
		.description("render the goal DAG as text")
		.action((_options, command) => mapCommand(command));
	program
		.command("log")
		.description("show the event stream (--tail N)")
		.option("--tail <n>", "number of recent events", "20")
		.action(logCommand);
	program
		.command("sync")
		.description("run one Runtime cycle")
		.action((_options, command) => syncCommand(command));
	program
		.command("watch")
		.description("watch the blackboard and run the Runtime loop on changes")
		.action((_options, command) => watchCommand(command));
	program
		.command("doctor")
		.description(
			"run consistency checks over the blackboard (exit 1 on errors)",
		)
		.action((_options, command) => doctorCommand(command));

	program
		.command("ui")
		.description(
			"serve a local web dashboard for the blackboard (default port 7700)",
		)
		.option("--port <n>", "port to listen on", "7700")
		.option(
			"--ui-dir <path>",
			"serve dashboard assets from this directory instead of the embedded bundle",
		)
		.action((options: { port?: string; uiDir?: string }, command: Command) =>
			uiCommand(options, command),
		);

	const config = program
		.command("config")
		.description("inspect and edit workbench.yaml");
	config
		.command("set <key> <value>")
		.description("set a config value, e.g. scheduler.policy auto")
		.action((key: string, value: string, _options: unknown, command: Command) =>
			configSet(key, value, command),
		);

	return program;
}
