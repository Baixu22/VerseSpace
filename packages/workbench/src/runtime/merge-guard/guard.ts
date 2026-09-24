import type { Blackboard } from "../../blackboard";
import { MAX_CONCURRENCY, mapWithLimit } from "./concurrency";
import { overlappingWrites, recentAuthors } from "./overlap";
import { predictConflicts } from "./preflight";
import {
	conflictedPaths,
	type MergeGuardResult,
	type OverlapWarning,
} from "./types";

/**
 * One pass: predict real conflicts between refs, then decide which write-set
 * overlaps are surprising enough to be worth a word.
 *
 * `rareAuthorThreshold`: a file whose recent history has at most this many
 * distinct authors is not normally shared, so two writers on it is news.
 */
export async function runMergeGuard(
	bb: Blackboard,
	refs: string[],
	options: { rareAuthorThreshold?: number; historyLimit?: number } = {},
): Promise<MergeGuardResult> {
	const startedAt = Date.now();
	const rareAuthorThreshold = options.rareAuthorThreshold ?? 1;
	const historyLimit = options.historyLimit ?? 50;

	const predictions = await predictConflicts(bb.projectRoot, refs);
	const overlaps = await overlappingWrites(bb);

	// one history query per distinct overlapping path, and only for paths
	// git did NOT already flag — a predicted conflict is strictly stronger
	const predicted = new Set(
		predictions.flatMap((p) => conflictedPaths(p.preflight)),
	);
	const candidates = [
		...new Set(overlaps.flatMap((overlap) => overlap.paths)),
	].filter((path) => !predicted.has(path));

	const authorsByPath = new Map<string, string[]>();
	await mapWithLimit(candidates, MAX_CONCURRENCY, async (path) => {
		authorsByPath.set(
			path,
			await recentAuthors(bb.projectRoot, path, historyLimit),
		);
	});

	const warnings: OverlapWarning[] = [];
	for (const overlap of overlaps) {
		for (const path of overlap.paths) {
			if (predicted.has(path)) {
				continue; // already covered by a real conflict prediction
			}
			const authors = authorsByPath.get(path) ?? [];
			if (authors.length > rareAuthorThreshold) {
				continue; // routinely shared: not news, don't train them to ignore us
			}
			warnings.push({
				a: overlap.a,
				b: overlap.b,
				path,
				authors,
				reason:
					`${overlap.a} 与 ${overlap.b} 都在改 ${path}，` +
					`而这个文件近期只有 ${authors.length} 位作者碰过（不是常共享的文件）。` +
					"git 还没判出冲突，但重叠本身值得先说一句。",
			});
		}
	}

	return { predictions, warnings, elapsedMs: Date.now() - startedAt };
}
