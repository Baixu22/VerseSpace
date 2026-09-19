import { Command } from "commander";
import { registerAgents } from "./cli/agents";
import { registerFoundation } from "./cli/foundation";
import { registerMcp } from "./cli/mcp";
import { registerTribunal } from "./cli/tribunal";
import { registerWorkspace } from "./cli/workspace";
import { WORKBENCH_VERSION } from "./version";
export function buildProgram(): Command {
	const program = new Command();
	program
		.name("workbench")
		.description("CLI + filesystem state manager for AI-assisted development")
		.version(WORKBENCH_VERSION)
		.option("--json", "emit machine-readable JSON output")
		.option("--quiet", "suppress human-readable output");
	registerFoundation(program);
	registerAgents(program);
	registerMcp(program);
	registerTribunal(program);
	registerWorkspace(program);
	return program;
}
