import type { Command } from "commander";
import {
	checkpointCreate,
	checkpointList,
	checkpointReview,
} from "../commands/checkpoint";
import { checkpointConsume } from "../commands/checkpoint-consume";
import { checkpointExport } from "../commands/checkpoint-export";
import { checkpointReceive } from "../commands/checkpoint-receive";
import { checkpointRevalidate } from "../commands/checkpoint-revalidate";
import { configSet, queueCommand } from "../commands/config";

import { dispatchCommand } from "../commands/dispatch";
import { doctorCommand } from "../commands/doctor";

import { registerInterestCommands } from "../commands/interest";

import { checkpointRestore } from "../commands/restore";

import {
	logCommand,
	mapCommand,
	statusCommand,
	syncCommand,
} from "../commands/sync";

import { uiCommand } from "../commands/ui";
import { watchCommand } from "../commands/watch";

import { wsCreate, wsList, wsReassign, wsStatus } from "../commands/ws";

export function registerWorkspace(program: Command): void {
	const ws = program.command("ws").description("manage workspots");

	ws.command("create <id>")
		.description(
			"create a workspot (--task goal-id, --branch, --worktree path)",
		)
		.requiredOption("--task <goal-id>", "primary goal for this workspot")
		.requiredOption("--branch <branch>", "git branch this workspot holds")
		.option("--worktree <path>", "worktree path (default worktrees/<id>)")
		.action(
			async (
				id: string,
				options: { task?: string; branch?: string; worktree?: string },
				command: Command,
			) => {
				await wsCreate(
					id,
					options as { task: string; branch: string; worktree?: string },
					command,
				);
			},
		);

	ws.command("list")
		.description("list workspots")
		.action((_options, command) => wsList(command));

	ws.command("reassign <id>")
		.description("reassign a workspot (--task goal-id, --temporary borrows it)")
		.requiredOption("--task <goal-id>", "new goal for this workspot")
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
				await wsReassign(
					id,
					options as { task: string; temporary?: boolean },
					command,
				);
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
		.option(
			"--evidence <json-file>",
			"declared Vitest report, exact test names and non-sensitive file inputs",
		)
		.option("--artifact <path>", "single artifact relative to the workspot")
		.option("--input <paths...>", "explicit artifact input dependencies")
		.option(
			"--input-records <json-file>",
			"explicit path/writerId/footprintSeq/selector read-record selections",
		)
		.option("--target-ref <ref>", "explicit handoff target ref")
		.option("--writer <id>", "writer responsible for this artifact")
		.option("--thread <id>", "thread to show artifact evidence in")
		.action(checkpointCreate);

	checkpoint
		.command("revalidate <id>")
		.description("run declared artifact checks again without repeating effects")
		.option("--workspot <id>", "explicit execution workspot for this new check")
		.option("--target-ref <ref>", "explicit new target baseline")
		.option(
			"--target-candidate",
			"actually verify this explicit workspot as a candidate on the target base",
		)
		.action(checkpointRevalidate);
	checkpoint
		.command("export <id>")
		.description(
			"export a portable declared-scope artifact manifest without commands or local paths",
		)
		.option("--output <path>", "write a new manifest file (never overwrite)")
		.action(checkpointExport);
	checkpoint
		.command("receive <manifest-file>")
		.description(
			"check portable objects in an explicit workspot; revalidate with an existing local policy",
		)
		.requiredOption(
			"--checkpoint <id>",
			"receiver's existing local checkpoint policy",
		)
		.requiredOption(
			"--workspot <id>",
			"explicit relative-root mapping to a receiver workspot",
		)
		.requiredOption(
			"--report <path>",
			"sender report relative to the receiver workspot",
		)
		.option(
			"--revalidate",
			"run the receiver's local fixed-file policy and keep a new check",
		)
		.action(checkpointReceive);

	checkpoint
		.command("consume <id>")
		.description(
			"accept a declared artifact with its latest verified evidence once",
		)
		.requiredOption(
			"--evidence <checkpoint-id>",
			"exact latest checkpoint that authorizes consumption",
		)
		.action(checkpointConsume);

	checkpoint
		.command("list")
		.description("list checkpoints (--staging | --verified | --failed)")
		.option("--staging", "list only the staging zone")
		.option("--verified", "list only the verified zone")
		.option("--failed", "list only the failed zone")
		.option(
			"--artifact-view",
			"bounded artifact facts shared with MCP and restore",
		)
		.option("--writer <id>", "filter the artifact view by writer or thread")
		.action(checkpointList);

	checkpoint
		.command("restore <id>")
		.description(
			"roll back a checkpoint (--code | --context | --both; dry-run by default)",
		)
		.option("--code", "restore code only (git checkout to the captured HEAD)")
		.option("--context", "restore context only (roll back blackboard keys)")
		.option("--both", "restore code and context")
		.option("--yes", "actually apply; without it the plan is dry-run only")
		.option("--label <text>", "label this undo (recorded as a negative sample)")
		.action(checkpointRestore);

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
		.option(
			"--force",
			"dispatch even when the CONWIP pool is full (logged, never silent)",
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
			"context-rot check on instruction files; blackboard sweep if a workspace exists",
		)
		.action((_options, command) => doctorCommand(command));

	program
		.command("ui")
		.description(
			"serve a local web dashboard for the blackboard (default port 7700)",
		)
		.option("--port <n>", "port to listen on", "7700")
		.option("--no-open", "start the server without opening a browser")
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

	registerInterestCommands(program);
}
