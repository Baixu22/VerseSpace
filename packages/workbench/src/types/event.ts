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
}

export interface EventFilter {
	type?: string;
	source?: string;
	limit?: number;
}
