import type { Blackboard } from "../blackboard";
import { git } from "../git";
import { branchNameProblem } from "../git/refname";
import { runMergeGuard } from "../runtime/merge-guard";
import { envelopes } from "../tribunal/envelopes";
import type { Workspot } from "../types/workspot";
import type { SchedulerNotify } from "./notifications";

/** Advisory preflight shared by automatic, CLI, and HTTP dispatch. */
export async function guardBeforeDispatch(
	bb: Blackboard,
	incoming: Workspot,
	notify: SchedulerNotify,
): Promise<void> {
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
	await bb.events.append({
		timestamp: new Date().toISOString(),
		source: "scheduler",
		type: "merge_guard",
		payload: {
			refs: [...refs],
			predictions: guard.predictions.length,
			conflicts: guard.predictions.filter(
				(prediction) => prediction.conflicting.length > 0,
			).length,
			overlaps: guard.warnings.length,
			errors: guard.predictions.filter(
				(prediction) => prediction.error !== undefined,
			).length,
			elapsedMs: guard.elapsedMs,
		},
	});
	for (const prediction of guard.predictions) {
		if (prediction.error !== undefined) {
			await notify(
				`合并预检 ${prediction.a} ↔ ${prediction.b} 未完成：${prediction.error}`,
				"warning",
			);
		} else if (prediction.conflicting.length > 0) {
			await notify(
				`${prediction.a} 与 ${prediction.b} 合并会冲突：${prediction.conflicting.slice(0, 5).join("、")}`,
				"warning",
				envelopes.mergeConflictPredicted(
					prediction.a,
					prediction.b,
					prediction.conflicting,
				),
			);
		}
	}
	for (const warning of guard.warnings) {
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
}
