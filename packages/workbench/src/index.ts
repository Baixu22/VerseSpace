#!/usr/bin/env bun
import { buildProgram } from "./cli";
import { emitError } from "./output";

try {
	await buildProgram().parseAsync(process.argv);
} catch (error) {
	const json = process.argv.includes("--json");
	process.exit(emitError(error, json));
}
