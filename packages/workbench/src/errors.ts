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

/**
 * A CAS (compare-and-set) write lost the race: the on-disk version or hash
 * did not match the caller's precondition. `current` carries the object that
 * IS on disk so the caller can rebase and retry without a second read.
 */
export class BlackboardConflictError extends BlackboardDataError {
	constructor(
		message: string,
		path: string,
		readonly current: unknown,
	) {
		super(message, path);
		this.name = "BlackboardConflictError";
	}
}
