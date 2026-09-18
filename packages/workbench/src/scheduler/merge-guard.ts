import type { Blackboard } from "../blackboard";
import { git } from "../git";
import { branchNameProblem } from "../git/refname";
import {
	type MergeGuardResult,
	type OverlapWarning,
	runMergeGuard,
} from "../runtime/merge-guard";
import { envelopes } from "../tribunal/envelopes";
import type { Workspot } from "../types/workspot";
import type { SchedulerNotify } from "./notifications";

/**
 * TF-0208: what an advisory preflight learned.
 *
 * Every pair ends in exactly one of three places, so a caller can tell "git
 * merged them and found nothing" apart from "nobody got an answer" — the
 * distinction the event payload used to blur into a single `errors` counter.
 * The preflight stays advisory: it never blocks a dispatch.
 */
export interface MergePreflightReport {
	refs: string[];
	/** Pairs git merged and found clean. */
	clear: number;
	/** Pairs git merged and found conflicting, with the paths it named. */
	conflicts: Array<{ a: string; b: string; paths: string[] }>;
	/** Pairs nobody could answer (unsupported / unresolved), with the reason. */
	unanswered: Array<{ a: string; b: string; reason: string }>;
	/** Write-set overlaps surprising enough to mention. */
	warnings: OverlapWarning[];
	elapsedMs: number;
}

/** Collapse the raw predictions into the three outcomes callers branch on. */
function summarize(
	guard: MergeGuardResult,
	refs: string[],
): MergePreflightReport {
	const conflicts: MergePreflightReport["conflicts"] = [];
	const unanswered: MergePreflightReport["unanswered"] = [];
	let clear = 0;
	for (const { a, b, preflight } of guard.predictions) {
		switch (preflight.kind) {
			case "clear":
				clear += 1;
				break;
			case "conflicts":
				conflicts.push({ a, b, paths: preflight.paths });
				break;
			default:
				unanswered.push({ a, b, reason: preflight.reason });
		}
	}
	return {
		refs,
		clear,
		conflicts,
		unanswered,
		warnings: guard.warnings,
		elapsedMs: guard.elapsedMs,
	};
}

/** Advisory preflight shared by automatic, CLI, and HTTP dispatch. */
export async function guardBeforeDispatch(
	bb: Blackboard,
	incoming: Workspot,
	notify: SchedulerNotify,
): Promise<MergePreflightReport> {
	const workspots = await bb.state.workspots.list();
	const branches = [
		...new Set([
			...workspots
				.filter((workspot) => workspot.status === "active")
				.map((workspot) => workspot.branch),
			incoming.branch,
		]),
	].sort();
	const refs = new Set<string>();
	for (const branch of branches) {
		const result =
			branchNameProblem(branch) === null
				? await git(
						[
							"rev-parse",
							"--verify",
							"--quiet",
							"--end-of-options",
							`refs/heads/${branch}^{commit}`,
						],
						bb.projectRoot,
					)
				: null;
		if (result?.ok) refs.add(`refs/heads/${branch}`);
		else if (branch === incoming.branch)
			refs.add("HEAD"); // createWorktree branches from HEAD.
		else
			await notify(
				`工位分支 ${branch} 不存在或无效，无法完成合并预检`,
				"warning",
			);
	}
	// ponytail: pairwise git checks run only at dispatch; cache by commit IDs if the lane count grows.
	// Overlap checks also matter when several writers share a single branch.
	const guard = await runMergeGuard(bb, [...refs]);
	const report = summarize(guard, [...refs]);
	await bb.events.append({
		timestamp: new Date().toISOString(),
		source: "scheduler",
		type: "merge_guard",
		payload: {
			refs: report.refs,
			pairs: report.clear + report.conflicts.length + report.unanswered.length,
			clear: report.clear,
			conflicts: report.conflicts.length,
			unanswered: report.unanswered.length,
			overlaps: report.warnings.length,
			elapsedMs: report.elapsedMs,
		},
	});
	for (const { a, b, paths } of report.conflicts) {
		await notify(
			`${a} 与 ${b} 合并会冲突：${paths.slice(0, 5).join("、")}`,
			"warning",
			envelopes.mergeConflictPredicted(a, b, paths),
		);
	}
	for (const { a, b, reason } of report.unanswered) {
		await notify(`合并预检 ${a} ↔ ${b} 没有结论：${reason}`, "warning");
	}
	for (const warning of report.warnings) {
		await notify(
			warning.reason,
			"info",
			envelopes.writeOverlapRare(
				warning.a,
				warning.b,
				warning.path,
				warning.authors,
			),
		);
	}
	return report;
}
