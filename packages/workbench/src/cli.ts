import { Command } from "commander";
import { notImplemented } from "./commands/not-implemented";
import { WORKBENCH_VERSION } from "./version";

const pending = notImplemented;

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
		.action(pending("init"));

	const goal = program.command("goal").description("manage goals");
	goal
		.command("add <title>")
		.description("add a goal")
		.action(pending("goal add"));
	goal
		.command("list")
		.description("list all goals")
		.action(pending("goal list"));
	goal
		.command("show <id>")
		.description("show one goal in detail")
		.action(pending("goal show"));
	goal
		.command("cancel <id>")
		.description("cancel a goal")
		.action(pending("goal cancel"));

	const decision = program
		.command("decision")
		.description("record architecture decisions");
	decision
		.command("add <title>")
		.description("add a decision (--rationale)")
		.action(pending("decision add"));

	const iface = program
		.command("interface")
		.description("manage the interface registry");
	iface
		.command("register <path>")
		.description("register an interface file (--key)")
		.action(pending("interface register"));
	iface
		.command("list")
		.description("list registered interfaces")
		.action(pending("interface list"));
	iface
		.command("check")
		.description("check all interfaces for hash drift")
		.action(pending("interface check"));

	const ws = program.command("ws").description("manage workspots");
	ws.command("create <id>")
		.description("create a workspot (--task, --branch)")
		.action(pending("ws create"));
	ws.command("list").description("list workspots").action(pending("ws list"));
	ws.command("reassign <id>")
		.description("reassign a workspot (--task, --temporary)")
		.action(pending("ws reassign"));
	ws.command("status <id>")
		.description("show one workspot")
		.action(pending("ws status"));

	const checkpoint = program
		.command("checkpoint")
		.description("manage checkpoints");
	checkpoint
		.command("create")
		.description("create a checkpoint interactively")
		.action(pending("checkpoint create"));
	checkpoint
		.command("list")
		.description("list checkpoints (--staging | --verified | --failed)")
		.action(pending("checkpoint list"));
	checkpoint
		.command("review <id>")
		.description("review a checkpoint awaiting human review")
		.action(pending("checkpoint review"));

	program
		.command("dispatch <goal-id> [workspot-id]")
		.description("dispatch a goal to a workspot")
		.action(pending("dispatch"));
	program
		.command("queue")
		.description("show the execution queue")
		.action(pending("queue"));
	program
		.command("status")
		.description("global status overview")
		.action(pending("status"));
	program
		.command("map")
		.description("render the goal DAG as text")
		.action(pending("map"));
	program
		.command("log")
		.description("show the event stream (--tail N)")
		.action(pending("log"));
	program
		.command("sync")
		.description("run one Runtime cycle")
		.action(pending("sync"));
	program
		.command("watch")
		.description("run the watcher loop")
		.action(pending("watch"));
	program
		.command("doctor")
		.description("run consistency checks")
		.action(pending("doctor"));

	const config = program
		.command("config")
		.description("inspect and edit workbench.yaml");
	config
		.command("set <key> <value>")
		.description("set a config value")
		.action(pending("config set"));

	return program;
}
