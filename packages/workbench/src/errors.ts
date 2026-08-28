/** A blackboard file exists but its content does not satisfy its schema. */
export class BlackboardDataError extends Error {
	constructor(
		message: string,
		readonly path: string,
	) {
		super(message);
		this.name = "BlackboardDataError";
	}
}

/** The command needs a `.workbench/` workspace but none was found. */
export class NoWorkbenchError extends Error {
	constructor(startDir: string) {
		super(
			`no .workbench/ directory found (searched upward from ${startDir}); run 'workbench init' first`,
		);
		this.name = "NoWorkbenchError";
	}
}
