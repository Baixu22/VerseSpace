import type { Command } from "commander";

import { statsCommand } from "../commands/stats";

import {
	tribunalListCommand,
	tribunalResolveCommand,
	tribunalShelveCommand,
	tribunalShowCommand,
	tribunalStatsCommand,
} from "../commands/tribunal";

import { metricsCommand, wipCommand } from "../commands/wip";

export function registerTribunal(program: Command): void {
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
}
