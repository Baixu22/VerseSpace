import { BlackboardDataError } from "./errors";

export const EXIT_CODES = {
	OK: 0,
	ERROR: 1,
	USAGE: 2,
} as const;

export interface GlobalOptions {
	json?: boolean;
	quiet?: boolean;
}

export class WorkbenchError extends Error {
	constructor(
		message: string,
		readonly exitCode: number = EXIT_CODES.ERROR,
	) {
		super(message);
		this.name = "WorkbenchError";
	}
}

export function emitJson(data: unknown): void {
	console.log(JSON.stringify(data, null, 2));
}

export function emitError(error: unknown, json: boolean): number {
	const message = error instanceof Error ? error.message : String(error);
	const path = error instanceof BlackboardDataError ? error.path : undefined;
	const exitCode =
		error instanceof WorkbenchError ? error.exitCode : EXIT_CODES.ERROR;
	if (json) {
		emitJson({ ok: false, error: message, ...(path ? { path } : {}) });
	} else {
		console.error(`workbench: ${path ? `${path}: ` : ""}${message}`);
	}
	return exitCode;
}
