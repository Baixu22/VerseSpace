import {
	checkpointAwaitingReview,
	checkpointWithoutPolicy,
} from "./checkpoint";
import { deadDependency, missingDependency } from "./dependency";
import { metricCacheMiss, metricSuspend, metricToolBloat } from "./lane";
import {
	concurrencyCap,
	dispatchSuggestion,
	noIdleWorkspot,
	staleQueueEntries,
} from "./queue";
import {
	agentCrashloop,
	dispatchFailed,
	mergeConflictPredicted,
	writeOverlapRare,
} from "./runtime";
import {
	blockedWorkspot,
	branchInUse,
	invalidBranchName,
	orphanTask,
} from "./workspot";

/**
 * Every "a human needs to decide this" emitter, through one module.
 *
 * The wording lives here rather than at the call site because the acceptance
 * criteria are about the wording: every card must end in a recommendation
 * (never a question), must name the consequence of inaction, and must carry an
 * action a human can actually take. Spread across five machines those
 * guarantees rot; the shared builders keep those guarantees reviewable.
 *
 * Each builder takes exactly the identifiers the emitter already has — an
 * emitter never invents context it cannot see.
 */

export const envelopes = {
	missingDependency,
	deadDependency,
	orphanTask,
	blockedWorkspot,
	invalidBranchName,
	branchInUse,
	checkpointWithoutPolicy,
	checkpointAwaitingReview,
	staleQueueEntries,
	noIdleWorkspot,
	dispatchSuggestion,
	concurrencyCap,
	metricCacheMiss,
	metricToolBloat,
	metricSuspend,
	mergeConflictPredicted,
	writeOverlapRare,
	dispatchFailed,
	agentCrashloop,
};
