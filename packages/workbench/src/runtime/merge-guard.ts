import type { Blackboard } from "../blackboard";
import { git } from "../git";
import {
	type MergeTreeSupport,
	parseMergeTreeOutput,
	probeMergeTree,
} from "../git/merge-tree";

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

/** Pairs are evaluated concurrently: process startup dominates, not CPU. */
const MAX_CONCURRENCY = 8;

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

/**
 * Ask git one question about one pair. Failures are answers here, not
 * exceptions — nothing in this layer throws.
 *
 * The `code === 1` branch is where the old code went wrong. git uses it for
 * both "they conflict" and "not something we can merge" (which it reports on
 * stderr with an empty stdout). Only a *parsed, non-empty* path list is a
 * conflict answer; everything else is `unresolved`, because reporting an empty
 * conflict list would claim a clean merge that was never predicted.
 */
export async function preflightPair(
	projectRoot: string,
	a: string,
	b: string,
	support: MergeTreeSupport,
): Promise<MergePreflight> {
	if (support.kind === "unsupported") {
		return { kind: "unsupported", reason: support.reason };
	}
	const result = await git(
		["merge-tree", "--write-tree", "--name-only", a, b],
		projectRoot,
	);
	if (result.code === 0) {
		return { kind: "clear" };
	}
	if (result.code === null) {
		return {
			kind: "unsupported",
			reason: result.stderr.trim() || "git 没能启动",
		};
	}
	if (result.code !== 1) {
		return {
			kind: "unresolved",
			reason: result.stderr.trim() || `git merge-tree 退出码 ${result.code}`,
		};
	}
	const paths = parseMergeTreeOutput(result.stdout);
	if (paths === null) {
		return {
			kind: "unresolved",
			reason: result.stderr.trim() || "git 的输出不是可解析的合并结论",
		};
	}
	if (paths.length === 0) {
		return {
			kind: "unresolved",
			reason: result.stderr.trim() || "git 报了冲突但没有列出路径",
		};
	}
	return { kind: "conflicts", paths };
}

/** Distinct authors of the last `limit` commits touching `path`. */
export async function recentAuthors(
	projectRoot: string,
	path: string,
	limit = 50,
): Promise<string[]> {
	const result = await git(
		["log", `--format=%an`, "-n", String(limit), "--", path],
		projectRoot,
	);
	if (!result.ok) {
		return []; // no history (untracked file) is not an error condition
	}
	const authors = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	return [...new Set(authors)];
}

/** Files more than one writer has written to inside the window. */
export async function overlappingWrites(
	bb: Blackboard,
	windowMs = 30 * 60_000,
): Promise<Array<{ a: string; b: string; paths: string[] }>> {
	const cutoff = Date.now() - windowMs;
	const writers = await bb.sessions.list();
	const recent = new Map<string, Set<string>>();
	for (const writer of writers) {
		const { writes } = await bb.sessions.readSetView(writer.id);
		const paths = new Set(
			writes
				.filter((write) => Date.parse(write.ts) >= cutoff)
				.map((write) => write.path),
		);
		if (paths.size > 0) {
			recent.set(writer.id, paths);
		}
	}
	const ids = [...recent.keys()];
	const overlaps: Array<{ a: string; b: string; paths: string[] }> = [];
	for (let i = 0; i < ids.length; i += 1) {
		for (let j = i + 1; j < ids.length; j += 1) {
			const a = ids[i]!;
			const b = ids[j]!;
			const shared = [...recent.get(a)!].filter((path) =>
				recent.get(b)!.has(path),
			);
			if (shared.length > 0) {
				overlaps.push({ a, b, paths: shared.sort() });
			}
		}
	}
	return overlaps;
}

async function mapWithLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
		(async () => {
			for (;;) {
				const index = cursor;
				cursor += 1;
				if (index >= items.length) {
					return;
				}
				results[index] = await fn(items[index]!);
			}
		})(),
	);
	await Promise.all(workers);
	return results;
}

/**
 * Pairwise conflict prediction across refs. N² calls, but run concurrently.
 *
 * The capability probe runs once and covers the whole sweep: a git that cannot
 * answer should be named once, not asked N² times.
 */
export async function predictConflicts(
	projectRoot: string,
	refs: string[],
): Promise<MergePrediction[]> {
	const pairs: Array<[string, string]> = [];
	for (let i = 0; i < refs.length; i += 1) {
		for (let j = i + 1; j < refs.length; j += 1) {
			pairs.push([refs[i]!, refs[j]!]);
		}
	}
	if (pairs.length === 0) {
		return []; // nothing to ask, so nothing to probe for
	}
	const support = await probeMergeTree(projectRoot);
	return mapWithLimit(pairs, MAX_CONCURRENCY, async ([a, b]) => ({
		a,
		b,
		preflight: await preflightPair(projectRoot, a, b, support),
	}));
}

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
