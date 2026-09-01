import type { Blackboard } from "../blackboard";
import { generateContext } from "../contextgen/generate";
import { createWorktree } from "../git";
import type { SchedulerPolicy } from "../types/config";
import type { TribunalEnvelope } from "../types/tribunal";
import type { Workspot } from "../types/workspot";
import { type DispatchDecision, type SchedulerState, tick } from "./tick";
import { admitDispatch } from "./wip";

export interface DispatchResult {
	ok: boolean;
	goalId: string;
	workspotId?: string;
	worktree?: string;
	reason?: string;
}

/**
 * The concrete dispatch action (skeleton Phase 5): create/bind the git
 * worktree, activate the workspot on the goal, dequeue it, and refresh the
 * workspot's context file. Used by `workbench dispatch` regardless of policy,
 * and by the Runtime when the auto scheduler decides.
 */
export async function dispatchGoal(
	bb: Blackboard,
	goalId: string,
	workspotId?: string,
	options: { force?: boolean } = {},
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

	const worktree = await createWorktree(
		bb.projectRoot,
		workspot.worktreePath,
		workspot.branch,
	);
	if (!worktree.ok) {
		return {
			ok: false,
			goalId,
			workspotId: workspot.id,
			worktree: worktree.path,
			reason: worktree.reason,
		};
	}

	await bb.state.workspots.save({
		...workspot,
		status: "active",
		primaryTask: goalId,
		currentTask: undefined,
		binding: "primary",
	});
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

/** Scheduler stage for the Runtime: tick and execute what policy allows. */
export async function runScheduler(
	bb: Blackboard,
	policy: Exclude<SchedulerPolicy, "manual">,
	maxConcurrentWorkspots: number,
	notify: (
		message: string,
		severity: "info" | "warning" | "error",
		/** R3: the structured envelope, when this decision is an alarm. */
		tribunal?: TribunalEnvelope,
	) => Promise<void>,
): Promise<DispatchResult[]> {
	const state: SchedulerState = {
		policy,
		queue: await bb.state.queue.get(),
		goals: await bb.goals.list(),
		workspots: await bb.state.workspots.list(),
		maxConcurrentWorkspots,
	};
	const decisions: DispatchDecision[] = tick(state);
	const results: DispatchResult[] = [];
	for (const decision of decisions) {
		if (decision.type === "notify_human") {
			await notify(decision.message, decision.severity, decision.tribunal);
			continue;
		}
		if (decision.type === "dispatch") {
			const result = await dispatchGoal(
				bb,
				decision.goalId,
				decision.workspotId,
			);
			results.push(result);
			await bb.events.append({
				timestamp: new Date().toISOString(),
				source: "scheduler",
				type: result.ok ? "goal_dispatched" : "dispatch_failed",
				payload: { ...result },
			});
		}
	}
	return results;
}
