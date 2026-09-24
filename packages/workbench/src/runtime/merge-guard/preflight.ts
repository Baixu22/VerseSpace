import { git } from "../../git";
import {
	type MergeTreeSupport,
	parseMergeTreeOutput,
	probeMergeTree,
} from "../../git/merge-tree";
import { MAX_CONCURRENCY, mapWithLimit } from "./concurrency";
import type { MergePrediction, MergePreflight } from "./types";

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
