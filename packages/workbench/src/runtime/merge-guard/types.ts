export interface MergePrediction {
	a: string;
	b: string;
	preflight: MergePreflight;
}

/**
 * TF-0208: outcome of asking git whether two refs merge cleanly.
 *
 * Four arms, each carrying its own reason, so callers map instead of judging.
 * The split exists because `merge-tree` exit code 1 means two different things
 * — "they conflict" *and* "I won't answer" (bad ref, empty output). Folding
 * both into an empty path list published a clean merge nobody had predicted.
 */
export type MergePreflight =
	/** git merged them and reported no conflict. A real answer. */
	| { kind: "clear" }
	/** git merged them and these paths would conflict. A real answer. */
	| { kind: "conflicts"; paths: string[] }
	/** This git cannot answer at all (`merge-tree --write-tree` unavailable). */
	| { kind: "unsupported"; reason: string }
	/** git was asked and did not answer: bad ref, unreadable output, other failure. */
	| { kind: "unresolved"; reason: string };

/** Paths git says would conflict. Empty for every outcome that is not a conflict answer. */
export function conflictedPaths(preflight: MergePreflight): string[] {
	return preflight.kind === "conflicts" ? preflight.paths : [];
}

export interface OverlapWarning {
	a: string;
	b: string;
	path: string;
	/** Distinct authors that touched this file in recent history. */
	authors: string[];
	reason: string;
}

export interface MergeGuardResult {
	predictions: MergePrediction[];
	warnings: OverlapWarning[];
	elapsedMs: number;
}
