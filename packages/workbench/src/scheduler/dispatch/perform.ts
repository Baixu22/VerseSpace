import { incompleteDependencies } from "../../automaton/goal-validity";
import type { Blackboard } from "../../blackboard";
import { generateContext } from "../../contextgen/generate";
import { createWorktree } from "../../git";
import {
	removeWorktree,
	samePath,
	worktreeHoldingBranch,
} from "../../git/worktree";
import { envelopes } from "../../tribunal/envelopes";
import type { Workspot } from "../../types/workspot";
import { guardBeforeDispatch } from "../merge-guard";
import type { SchedulerNotify } from "../notifications";
import { admitDispatch } from "../wip";
import { checkBranchName } from "./branch";
import { claimOf, restoreIdle } from "./rollback";
import type { DispatchResult } from "./types";

/**
 * The concrete dispatch action (skeleton Phase 5): create/bind the git
 * worktree, activate the workspot on the goal, dequeue it, and refresh the
 * workspot's context file. Used by `workbench dispatch` regardless of policy,
 * and by the Runtime when the auto scheduler decides.
 */
export async function performDispatch(
	bb: Blackboard,
	goalId: string,
	workspotId: string | undefined,
	options: { force?: boolean; notify: SchedulerNotify },
): Promise<DispatchResult> {
	const goal = await bb.goals.get(goalId);
	if (!goal) {
		return { ok: false, goalId, reason: "目标不存在" };
	}
	if (goal.status !== "ready") {
		return {
			ok: false,
			goalId,
			reason: `目标状态为 ${goal.status}，只有 ready 状态可以派发`,
		};
	}
	const blockers = incompleteDependencies(goal, await bb.snapshot());
	if (blockers.length > 0) {
		return {
			ok: false,
			goalId,
			reason: `依赖尚未有效完成：${blockers.join(", ")}`,
		};
	}
	// R3 / TF-0083: CONWIP gate. Checked before anything is created so a
	// refused dispatch leaves no half-built worktree behind.
	const admission = await admitDispatch(bb, options);
	if (!admission.allowed) {
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "scheduler",
			type: "dispatch_refused",
			payload: {
				goalId,
				wipLimit: admission.wipLimit,
				inFlight: admission.inFlight,
				unreviewedBacklog: admission.unreviewedBacklog,
				basis: admission.basis,
			},
		});
		return { ok: false, goalId, reason: admission.reason };
	}

	let workspot: Workspot | null;
	if (workspotId !== undefined) {
		workspot = await bb.state.workspots.get(workspotId);
		if (!workspot) {
			return {
				ok: false,
				goalId,
				workspotId,
				reason: `工位不存在：${workspotId}`,
			};
		}
	} else {
		const idle = (await bb.state.workspots.list())
			.filter((ws) => ws.status === "idle")
			.sort((a, b) => a.id.localeCompare(b.id));
		workspot = idle[0] ?? null;
		if (!workspot) {
			return { ok: false, goalId, reason: "没有空闲工位" };
		}
	}
	if (workspot.status !== "idle") {
		return {
			ok: false,
			goalId,
			workspotId: workspot.id,
			reason: `工位 ${workspot.id} 状态为 ${workspot.status}，不是空闲`,
		};
	}

	const branchProblem = await checkBranchName(bb.projectRoot, workspot.branch);
	if (branchProblem !== null) {
		// Structured refusal, not a thrown stack: the queue gets a card a human
		// can act on, and no worktree was created.
		await bb.tribunal
			.submit(
				envelopes.invalidBranchName(
					workspot.id,
					workspot.branch,
					branchProblem,
				),
			)
			.catch((err) => {
				console.error(
					`[scheduler] 分支名拒派告警投递失败（${workspot.id}）:`,
					err,
				);
			});
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "scheduler",
			type: "dispatch_refused",
			payload: {
				goalId,
				workspotId: workspot.id,
				branch: workspot.branch,
				reason: "invalid_branch_name",
				detail: branchProblem,
			},
		});
		return {
			ok: false,
			goalId,
			workspotId: workspot.id,
			reason: `工位 ${workspot.id} 的分支名 ${workspot.branch} 不是合法 git ref：${branchProblem}`,
			error: {
				code: "invalid_branch_name",
				branch: workspot.branch,
				detail: branchProblem,
			},
		};
	}

	// TF-0202: git refuses to check one branch out in two worktrees at once.
	// Asking first turns that `fatal:` line into a named refusal; asking after
	// means the answer arrives as an opaque string from `git worktree add`.
	const holder = await worktreeHoldingBranch(bb.projectRoot, workspot.branch);
	if (!holder.ok) {
		// "Could not ask" is not "nobody holds it": warn and proceed, the same
		// way a failed merge pre-flight does not block dispatch (TF-0083).
		await options.notify(
			`工位 ${workspot.id} 的分支占用预检未完成：${holder.reason ?? "未知原因"}`,
			"warning",
		);
	} else if (
		holder.path !== null &&
		!samePath(bb.projectRoot, holder.path, workspot.worktreePath)
	) {
		// Another worktree holds the branch. Unless it is this workspot's own
		// checkout (a re-dispatch is idempotent), refuse without creating anything.
		const detail = `分支已被 ${holder.path} 检出`;
		await bb.tribunal
			.submit(
				envelopes.branchInUse(
					workspot.id,
					workspot.branch,
					holder.path,
					goalId,
				),
			)
			.catch((err) => {
				console.error(
					`[scheduler] 分支占用拒派告警投递失败（${workspot.id}）:`,
					err,
				);
			});
		await bb.events.append({
			timestamp: new Date().toISOString(),
			source: "scheduler",
			type: "dispatch_refused",
			payload: {
				goalId,
				workspotId: workspot.id,
				branch: workspot.branch,
				reason: "branch_in_use",
				holder: holder.path,
				detail,
			},
		});
		return {
			ok: false,
			goalId,
			workspotId: workspot.id,
			reason: `工位 ${workspot.id} 的分支 ${workspot.branch} 已被 worktree ${holder.path} 占用`,
			error: {
				code: "branch_in_use",
				branch: workspot.branch,
				holder: holder.path,
				detail,
			},
		};
	}

	await guardBeforeDispatch(bb, workspot, options.notify).catch((err) => {
		console.error(`[scheduler] 合并预检未完成（${workspot.id}）:`, err);
	});

	// TF-0203 phase 1: write the state row BEFORE touching git. From here on an
	// interrupted dispatch is visible as `initializing` and `runOnce` can repair
	// it; the old order (worktree first, row second) left a checkout nobody
	// owned and a workspot still claiming to be idle.
	await bb.state.workspots.save(claimOf(workspot, goalId, "initializing"));

	// Phase 2: create the checkout. A git failure rolls the row back, so the
	// workspot returns to a state the scheduler can pick up again.
	const worktree = await createWorktree(
		bb.projectRoot,
		workspot.worktreePath,
		workspot.branch,
	);
	if (!worktree.ok) {
		const restored = await restoreIdle(bb, workspot, "worktree_failed");
		return {
			ok: false,
			goalId,
			workspotId: workspot.id,
			worktree: worktree.path,
			reason: restored
				? worktree.reason
				: `${worktree.reason}（状态行回滚失败，sync 会在下一轮把它恢复为 idle）`,
		};
	}

	// Phase 3: activate. If the row cannot be written, undo the checkout: a
	// worktree with no workspot behind it is worse than no dispatch at all.
	try {
		await bb.state.workspots.save(claimOf(workspot, goalId, "active"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const rolled = await removeWorktree(bb.projectRoot, worktree.path, {
			force: true,
		});
		const restored = await restoreIdle(bb, workspot, "activation_failed");
		return {
			ok: false,
			goalId,
			workspotId: workspot.id,
			worktree: worktree.path,
			reason: `工位激活失败：${message}；worktree ${rolled.ok ? "已回滚" : `未移除（${rolled.reason}）`}${restored ? "" : "，状态行回滚也失败"}`,
		};
	}
	await bb.state.queue.dequeue(goalId);
	await generateContext(bb, workspot.id);
	await bb.events.append({
		timestamp: new Date().toISOString(),
		source: "scheduler",
		type: "goal_dispatched",
		payload: {
			goalId,
			workspotId: workspot.id,
			worktree: worktree.path,
			branch: workspot.branch,
		},
	});
	return { ok: true, goalId, workspotId: workspot.id, worktree: worktree.path };
}
