/**
 * The cheap merge safety net (R2, TF-0079).
 *
 * The posture is deliberate: merge-time is the wrong place to spend effort.
 * Real effort belongs upstream, in keeping changes small — that is a
 * scheduling problem, not a merge problem. So this layer only buys two things
 * that are nearly free and cannot be wrong:
 *
 * 1. `git merge-tree --write-tree --name-only` — an actual merge, so a
 *    predicted conflict is a real conflict. Zero false positives by
 *    construction: no heuristics, no similarity scores.
 * 2. A write-set overlap ledger, filtered by how surprising the overlap is.
 *    ConE's finding is that the signal is rarity: two writers landing on the
 *    same file is only news when that file is not normally shared. Notifying
 *    on every overlap trains people to ignore the channel.
 *
 * TF-0208 adds the outcome this layer used to lack. It knew only "they
 * conflict" and "git failed", and read exit code 1 as an answer either way —
 * so a ref git refused to resolve came back as an empty conflict list, a clean
 * bill of health nobody had issued. `MergePreflight` below makes "no answer"
 * first-class, and the capability probe makes "this git cannot answer" one
 * too. The zero-false-positive property is now guarded instead of assumed.
 *
 * Explicitly not here: semantic merge, LLM conflict resolution (agrees with
 * the developer only 55-59% of the time), constraint scheduling.
 */

export { runMergeGuard } from "./guard";
export { overlappingWrites, recentAuthors } from "./overlap";
export { predictConflicts, preflightPair } from "./preflight";
export {
	conflictedPaths,
	type MergeGuardResult,
	type MergePrediction,
	type MergePreflight,
	type OverlapWarning,
} from "./types";
