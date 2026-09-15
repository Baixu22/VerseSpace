import { Command } from "commander";
import { agentRun } from "./commands/agent";
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
import { registerInterestCommands } from "./commands/interest";
import {
	interfaceCheck,
	interfaceList,
	interfaceRegister,
} from "./commands/interface";
import {
	premisesPendingCommand,
	premisesSealCommand,
} from "./commands/premises";
import { checkpointRestore } from "./commands/restore";
import { registerSealReviewCommand } from "./commands/seal-review";
import {
	sessionsListCommand,
	sessionsRecordCommand,
	sessionsShowCommand,
} from "./commands/sessions";
import { statsCommand } from "./commands/stats";
import {
	logCommand,
	mapCommand,
	statusCommand,
	syncCommand,
} from "./commands/sync";
import {
	tribunalListCommand,
	tribunalResolveCommand,
	tribunalShelveCommand,
	tribunalShowCommand,
	tribunalStatsCommand,
} from "./commands/tribunal";
import { uiCommand } from "./commands/ui";
import { watchCommand } from "./commands/watch";
import { metricsCommand, wipCommand } from "./commands/wip";
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

	const agent = program
		.command("agent")
		.description("run agent sessions inside workspot worktrees");
	agent
		.command("run")
		.summary("run a non-interactive agent batch in a workspot")
		.description(
			"spawn the configured agent CLI in the worktree (--workspot, --prompt)",
		)
		.option("--workspot <id>", "workspot to run the agent in")
		.option("--prompt <text>", "task prompt (default: task title + acceptance)")
		.action(agentRun);

	const sessions = program
		.command("sessions")
		.description("registered writers and their read/write footprints (R1)");
	sessions
		.command("list")
		.summary("list registered writers")
		.description(
			"list every writer the runtime knows about (agent/human/git/ci)",
		)
		.action((_options, command) => sessionsListCommand(command));
	sessions
		.command("show <writer>")
		.summary("rebuild a writer's read/write view")
		.description(
			"fold the writer's footprint: which files it read at which version, and what it wrote",
		)
		.action(
			async (
				writer: string,
				_options: Record<string, unknown>,
				command: Command,
			) => {
				await sessionsShowCommand({ writer }, command);
			},
		);
	sessions
		.command("record")
		.summary("record a non-agent writer's activity (git hooks, editors, CI)")
		.description(
			"register a writer and append one footprint round to it. Paths come from " +
				"--generated / --used, or newline-separated on stdin, which is what the " +
				"git hooks use: `git diff-tree -r --name-only --no-commit-id A B | " +
				"workbench sessions record --activity post-merge`. Silently does nothing " +
				"outside a workbench workspace, so the hooks are safe to ship enabled.",
		)
		.option("--writer <id>", "writer id (default: git)")
		.option("--kind <kind>", "agent|human|git|ci (default: git)")
		.option("--label <text>", "human-readable label for a new writer")
		.option("--activity <name>", "activity name for this round")
		.option(
			"--generated <path>",
			"a path this writer wrote (repeatable)",
			(value: string, previous: string[] = []) => [...previous, value],
		)
		.option(
			"--used <path>",
			"a path this writer read (repeatable)",
			(value: string, previous: string[] = []) => [...previous, value],
		)
		.action(
			async (
				options: {
					writer?: string;
					kind?: string;
					label?: string;
					activity?: string;
					generated?: string[];
					used?: string[];
				},
				command: Command,
			) => {
				await sessionsRecordCommand(options, command);
			},
		);

	const premises = program
		.command("premises")
		.description("stale-premise notices recorded but not yet delivered (R2)");
	premises
		.command("pending")
		.summary("list notices still waiting for their writer")
		.description(
			"detection is advisory and runs anywhere; delivery needs a live session, so this is the backlog",
		)
		.action((_options, command) => premisesPendingCommand(command));
	premises
		.command("seal")
		.summary("PreToolUse hook: block a write into a stale region")
		.description(
			"the one place the runtime interrupts a writer. Reads a PreToolUse hook payload on stdin " +
				"(or --target); exit 2 blocks the call and feeds the evidence back to the model. " +
				"Every decision — block, warn, and pass alike — is recorded as a seal.decided event. " +
				"seal.mode in workbench.yaml picks the posture (block|warn|off); no mode is silent. " +
				"The hook wiring ships with the context-rot hooks installer and plugin bundle.",
		)
		.option("--writer <id>", "only consider this writer's stale region")
		.option("--target <path>", "explicit target instead of reading stdin")
		.option("--mode <mode>", "override seal.mode for this call: block|warn|off")
		.action(
			async (
				options: { writer?: string; target?: string; mode?: string },
				_command: Command,
			) => {
				await premisesSealCommand(options, _command);
			},
		);

	registerSealReviewCommand(premises);

	const tribunal = program
		.command("tribunal")
		.description(
			"the adjudication queue — everything that wants a human decision (R3)",
		);
	tribunal
		.command("list")
		.summary("list open items, highest SLA first")
		.description(
			"every item survived ISA-18.2 rationalization: it is abnormal, has a " +
				"consequence, and carries an action a human can take. --push shows only " +
				"what the human channel would actually interrupt for.",
		)
		.option("--all", "include resolved items (kept as evidence for a week)")
		.option("--push", "show only items that clear the binary push threshold")
		.action((options: { all?: boolean; push?: boolean }, command: Command) =>
			tribunalListCommand(options, command),
		);
	tribunal
		.command("show <id>")
		.summary("show one item as an SBAR card")
		.description(
			"the card always ends in a recommendation, never a question, and " +
				"explains how it was graded (consequence × deadline).",
		)
		.action((id: string, _options: unknown, command: Command) =>
			tribunalShowCommand({ id }, command),
		);
	tribunal
		.command("shelve <id>")
		.summary("defer an item (bounded to 5 minutes … 4 hours)")
		.description(
			"a deferral is not a dismissal: it reopens when it lapses. How often a " +
				"queue gets shelved is itself a KPI.",
		)
		.option("--minutes <n>", "deferral length in minutes", "30")
		.action((id: string, options: { minutes?: string }, command: Command) =>
			tribunalShelveCommand({ id, minutes: options.minutes }, command),
		);
	tribunal
		.command("resolve <id>")
		.summary("record the decision")
		.description(
			"the item leaves the open queue but stays on disk as evidence for a week.",
		)
		.action((id: string, _options: unknown, command: Command) =>
			tribunalResolveCommand({ id }, command),
		);
	tribunal
		.command("stats")
		.summary("the queue's own acceptance numbers")
		.description(
			"rate ≤ 6/hour, no flood, critical share ≤ 25%. A quarter criticals " +
				"means the grading failed, not that the work is that bad.",
		)
		.action((_options, command) => tribunalStatsCommand(command));

	program
		.command("wip")
		.description(
			"WIP derived by Little's Law from observed throughput and residence time (R3)",
		)
		.action((_options, command) => wipCommand(command));
	program
		.command("metrics")
		.description(
			"per-lane usage: absolute tokens / cache hit rate / compactions (R3)",
		)
		.action((_options, command) => metricsCommand(command));
	program
		.command("stats")
		.description("read-only chat/thread baseline for premise-custody fit")
		.action((_options, command) => statsCommand(command));

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
		.action(checkpointCreate);
	checkpoint
		.command("list")
		.description("list checkpoints (--staging | --verified | --failed)")
		.option("--staging", "list only the staging zone")
		.option("--verified", "list only the verified zone")
		.option("--failed", "list only the failed zone")
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
	return program;
}
