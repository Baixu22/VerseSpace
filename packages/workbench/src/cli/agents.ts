import type { Command } from "commander";
import { agentRun } from "../commands/agent";

import {
	premisesCurrentCommand,
	premisesPendingCommand,
	premisesSealCommand,
} from "../commands/premises";

import { registerSealReviewCommand } from "../commands/seal-review";
import { sessionsContinuityCommand } from "../commands/session-continuity";
import {
	sessionsListCommand,
	sessionsRecordCommand,
	sessionsShowCommand,
} from "../commands/sessions";

export function registerAgents(program: Command): void {
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

	sessions
		.command("continuity [thread]")
		.summary("read a thread's session continuity (identity, turns, delivery)")
		.description(
			"fold the three writers that already record a session's life — thread meta, " +
				"the message log and the event ledger — into one reading: which provider " +
				"session it is on, which turns completed, whether a turn was interrupted " +
				"and never answered, and which premise notices never reached it. " +
				"With no thread id it lists every thread and counts them. " +
				"Read-only: it never re-runs, re-delivers or edits a thread.",
		)
		.action(
			async (
				thread: string | undefined,
				_options: Record<string, unknown>,
				command: Command,
			) => {
				await sessionsContinuityCommand(thread, command);
			},
		);

	const premises = program
		.command("premises")
		.description(
			"current read premises, notice delivery and the seal point (R2)",
		);

	premises
		.command("pending")
		.summary("list notices still waiting for their writer")
		.description(
			"detection is advisory and runs anywhere; delivery needs a live session, so this is the backlog",
		)
		.action((_options, command) => premisesPendingCommand(command));
	premises
		.command("current")
		.summary("inspect current stale inputs independently of delivery")
		.option("--writer <id>", "only inspect this writer")
		.action(premisesCurrentCommand);

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
}
