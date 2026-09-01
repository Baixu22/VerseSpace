/**
 * Blackboard event log entry (events.jsonl). The payload is intentionally
 * open: any module may append structured events, and `doctor`/`workbench log`
 * render them without needing to know every shape.
 */
export interface WorkbenchEvent {
	timestamp: string;
	source: string;
	type: string;
	payload: unknown;
	/**
	 * Line number in the append-only log, assigned at read time: monotonic,
	 * serves as the causal order shared by footprints and DOI decay (R1/L1).
	 */
	seq?: number;
}

export interface EventFilter {
	type?: string;
	source?: string;
	limit?: number;
}
