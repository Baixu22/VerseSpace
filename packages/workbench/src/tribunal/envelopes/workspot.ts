import type { TribunalEnvelope } from "../../types/tribunal";

export function orphanTask(
	workspotId: string,
	taskId: string,
): TribunalEnvelope {
	return {
		kind: "workspot_orphan_task",
		subject: workspotId,
		causeKey: `workspot_orphan_task:${workspotId}:${taskId}`,
		action: {
			label: `把 ${workspotId} 改派到存在的目标，或关闭它`,
			command: `workbench ws reassign ${workspotId} --task <goal-id>`,
		},
		sbar: {
			situation: `工位 ${workspotId} 指向的目标 ${taskId} 不存在`,
			background:
				"工位靠 currentTask / primaryTask 关联目标，关联落空后它无法产出可归属的工作",
			assessment: `这个工位的产出不会被记到任何目标上，验证与复核都会落空`,
			recommendation: `给 ${workspotId} 指定一个真实目标；若它已无用，直接关闭`,
		},
	};
}

export function blockedWorkspot(
	workspotId: string,
	taskId: string,
	status: string,
): TribunalEnvelope {
	return {
		kind: "workspot_blocked",
		subject: workspotId,
		causeKey: `workspot_blocked:${workspotId}:${taskId}`,
		action: {
			label: `把 ${workspotId} 改派到 ${taskId} 之外的目标`,
			command: `workbench ws reassign ${workspotId} --task <goal-id>`,
		},
		sbar: {
			situation: `工位 ${workspotId} 被阻塞：任务 ${taskId} 处于 ${status}`,
			background: "任务失效后工位停在 blocked，不会自动释放",
			assessment: "工位继续空转，本轮产出为零，且不会被再次统计为可用工位",
			recommendation: `改派 ${workspotId}；若 ${taskId} 还要做，先重做它再谈改派`,
		},
	};
}

/**
 * TF-0117: the branch name a workspot carries is not a legal git ref, so
 * dispatch refused before creating anything. Reuses `workspot_blocked` — the
 * workspot genuinely cannot be dispatched — with its own cause key so it does
 * not fold into an unrelated block on the same lane.
 */
export function invalidBranchName(
	workspotId: string,
	branch: string,
	problem: string,
): TribunalEnvelope {
	return {
		kind: "workspot_blocked",
		subject: workspotId,
		causeKey: `workspot_blocked:invalid_branch:${workspotId}:${branch}`,
		action: {
			label: `把 ${workspotId} 的分支名改成合法 ref（当前 ${branch}）`,
			command: `workbench ws create ${workspotId} --branch <legal-branch>`,
		},
		sbar: {
			situation: `工位 ${workspotId} 的分支名 ${branch} 不是合法 git ref：${problem}`,
			background:
				"派发在 createWorktree 之前跑 git check-ref-format 预检，" +
				"因此本次没有留下半个 worktree，工位状态未变",
			assessment: `不改名的话 ${workspotId} 每次派发都会在同一处失败，且不会自动释放`,
			recommendation: `改成合法分支名后重新派发；名字里的 ${problem} 是唯一要修的地方`,
		},
		evidence: { commands: [`git check-ref-format --branch ${branch}`] },
	};
}

/**
 * TF-0202: the branch this workspot carries is already checked out in another
 * worktree, and git refuses to check one branch out twice. Same shape as
 * invalidBranchName — reused `workspot_blocked` kind with its own cause key —
 * because the workspot genuinely cannot start, and it must not fold into an
 * unrelated block on the same lane.
 */
export function branchInUse(
	workspotId: string,
	branch: string,
	holder: string,
	goalId: string,
): TribunalEnvelope {
	return {
		kind: "workspot_blocked",
		subject: workspotId,
		causeKey: `workspot_blocked:branch_in_use:${workspotId}:${branch}`,
		action: {
			label: `把 ${goalId} 派发到另一个空闲工位（${branch} 已被占用）`,
			command: `workbench dispatch ${goalId} <idle-workspot>`,
		},
		sbar: {
			situation: `工位 ${workspotId} 的分支 ${branch} 已被 worktree ${holder} 检出`,
			background:
				"同一条分支不能被两个 worktree 同时检出；派发在建 worktree 之前预检，" +
				"因此本次没有留下半个 worktree，工位状态未变",
			assessment: `不改分支或不释放占用者，${workspotId} 每次派发都会在同一处失败`,
			recommendation: `换一个空闲工位派发 ${goalId}；确实要用这个工位，就先释放 ${holder}`,
		},
		evidence: { commands: ["git worktree list --porcelain"] },
	};
}
