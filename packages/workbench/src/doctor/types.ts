import type { Checkpoint } from "../types/checkpoint";
import type { Goal } from "../types/goal";
import type { RegistryEntry } from "../types/interface-registry";
import type { Workspot } from "../types/workspot";

export interface DoctorIssue {
	/** machine-readable check id, e.g. dangling_dependency */
	check: string;
	severity: "error" | "warning";
	message: string;
	/** Where to look: goal id, checkpoint id, key, path... */
	subject?: string;
}

export interface DoctorReport {
	ok: boolean;
	issues: DoctorIssue[];
}

/** The ledger read every check works from, loaded once by `runDoctor`. */
export interface DoctorContext {
	goals: Goal[];
	workspots: Workspot[];
	interfaces: RegistryEntry[];
	queue: string[];
	staging: Checkpoint[];
	verified: Checkpoint[];
	failed: Checkpoint[];
	/** Goal ids, derived once — every cross-reference check needs the same set. */
	goalIds: Set<string>;
}
