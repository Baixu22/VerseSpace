import type { Command } from "commander";
import { EXIT_CODES, emitJson, type GlobalOptions } from "../output";

/**
 * Placeholder handler for scaffolded commands. Each real module (Blackboard,
 * Automaton, Verifier, ...) replaces these one command tree at a time.
 *
 * Commander calls actions as `(arg1..argN, options, command)`, so the command
 * object is always the last argument regardless of declared operands.
 */
export function notImplemented(commandPath: string) {
	return async (...handlerArgs: unknown[]): Promise<void> => {
		const command = handlerArgs.at(-1) as Command;
		const options = command.optsWithGlobals() as GlobalOptions;
		const detail = {
			ok: false,
			command: commandPath,
			error: "not_implemented",
		};
		if (options.json) {
			emitJson(detail);
		} else if (!options.quiet) {
			console.error(
				`workbench: '${commandPath}' is scaffolded but not implemented yet`,
			);
		}
		process.exitCode = EXIT_CODES.USAGE;
	};
}
