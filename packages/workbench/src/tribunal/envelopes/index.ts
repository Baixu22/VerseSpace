import type { TribunalEnvelope } from "../../types/tribunal";
import { metricCacheMiss, metricSuspend, metricToolBloat } from "./lane";
import {
	agentCrashloop,
	dispatchFailed,
	mergeConflictPredicted,
	writeOverlapRare,
} from "./runtime";

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

function missingDependency(
	goalId: string,
	missing: string[],
): TribunalEnvelope {
	const list = missing.join("、");
	return {
		kind: "dependency_missing",
		subject: goalId,
		causeKey: `dependency_missing:${goalId}:${missing.join(",")}`,
		action: {
			label: `补建 ${list}，或把 ${goalId} 的依赖改成已存在的目标`,
			command: `workbench goal add <${missing[0] ?? "目标"}>`,
		},
		sbar: {
			situation: `目标 ${goalId} 依赖的 ${list} 在目标表里不存在`,
			background: `${goalId} 仍处于 planned；依赖不解析成目标就无法进入就绪`,
			assessment: `不处理的话 ${goalId} 会永远停在 planned，且没人会再被提醒`,
			recommendation: `先建 ${missing[0] ?? "缺失目标"}，确认无误后再让 ${goalId} 自动就绪`,
		},
	};
}

function deadDependency(
	goalId: string,
	phase: "planned" | "ready",
	dead: Array<{ id: string; status: string }>,
): TribunalEnvelope {
	const list = dead.map((dep) => `${dep.id}(${dep.status})`).join("、");
	const blocked =
		phase === "ready" ? "它已在执行队列里，派发前必须处理" : "它无法进入就绪";
	return {
		kind: "dependency_dead",
		subject: goalId,
		causeKey: `dependency_dead:${phase}:${goalId}:${dead.map((d) => d.id).join(",")}`,
		action: {
			label: `重做或替换失效依赖 ${dead[0]?.id ?? ""}，再重跑 ${goalId}`,
			command: `workbench goal show ${dead[0]?.id ?? goalId}`,
		},
		sbar: {
			situation: `目标 ${goalId} 的依赖已失效：${list}`,
			background: `锚点失效意味着下游工作的前提变了；${blocked}`,
			assessment: `沿用旧前提继续施工会产出建立在失效接口上的代码`,
			recommendation: `确认 ${dead[0]?.id ?? "失效依赖"} 是否需要重做；重做后 ${goalId} 会自动恢复`,
		},
	};
}

function orphanTask(workspotId: string, taskId: string): TribunalEnvelope {
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

function blockedWorkspot(
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
function invalidBranchName(
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

function checkpointWithoutPolicy(
	cpId: string,
	workspot?: string,
): TribunalEnvelope {
	return {
		kind: "checkpoint_no_policy",
		subject: cpId,
		causeKey: `checkpoint_no_policy:${cpId}`,
		action: {
			label: `给 ${cpId} 补一条验证策略，或删掉这个草稿`,
			command: `workbench checkpoint create --goal <goal-id> --strategy test`,
		},
		sbar: {
			situation: `checkpoint ${cpId} 没有 verification 策略，停在 draft${workspot ? `（工位 ${workspot}）` : ""}`,
			background: "没有策略就没有可执行的验证，它既不会被验证也不会被归档",
			assessment: "这份工作永远拿不到证据，目标也就永远完成不了",
			recommendation: `补一条能跑的验证命令；如果只是随手记的草稿，删掉它`,
		},
	};
}

function checkpointAwaitingReview(cpId: string): TribunalEnvelope {
	return {
		kind: "checkpoint_needs_review",
		subject: cpId,
		causeKey: `checkpoint_needs_review:${cpId}`,
		action: {
			label: `审查 ${cpId}（通过或驳回）`,
			command: `workbench checkpoint review ${cpId} --approve`,
		},
		sbar: {
			situation: `checkpoint ${cpId} 等待人工审查`,
			background: "验证器给出了 needs_human，自动链条到此为止",
			assessment:
				"在审查之前，这条工作既不算完成也不算失败，目标会一直挂在 in_progress",
			recommendation: `看一眼产物；通过则 --approve 让它进入 verified，驳回则 --reject 让它进 failed`,
		},
	};
}

function staleQueueEntries(ids: string[]): TribunalEnvelope {
	return {
		kind: "queue_stale_entries",
		subject: "queue",
		causeKey: `queue_stale_entries:${ids.join(",")}`,
		action: {
			label: `清掉执行队列里的失效条目：${ids.join("、")}`,
			command: `workbench queue`,
		},
		sbar: {
			situation: `执行队列里有 ${ids.length} 个已失效的条目：${ids.join("、")}`,
			background: "条目对应的目标已经不是 ready，调度器不会派发它们",
			assessment: "队列长度会被高估，WIP 推导与准入控制都跟着失真",
			recommendation: "让队列自己排空即可；若长期不清，说明有目标卡在非终态",
		},
	};
}

function noIdleWorkspot(readyCount: number): TribunalEnvelope {
	return {
		kind: "no_idle_workspot",
		subject: "workspots",
		causeKey: "no_idle_workspot",
		action: {
			label: "新建一个工位，或等现有工位释放",
			command: "workbench ws create <id> --task <goal-id>",
		},
		sbar: {
			situation: `${readyCount} 个就绪目标等待派发，但没有空闲工位`,
			background: "工位是并发的物理上限；没有空位就没有新工作开始",
			assessment: "就绪目标继续堆积，吞吐由复核速度而非目标数量决定",
			recommendation:
				"先确认现有工位是不是卡在等复核；是的话先复核，别急着加工位",
		},
	};
}

function dispatchSuggestion(
	goalId: string,
	workspotId: string,
): TribunalEnvelope {
	return {
		kind: "dispatch_suggestion",
		subject: goalId,
		causeKey: `dispatch_suggestion:${goalId}`,
		action: {
			label: `派发 ${goalId} 到 ${workspotId}`,
			command: `workbench dispatch ${goalId} ${workspotId}`,
		},
		sbar: {
			situation: `有就绪目标可以派发到空闲工位 ${workspotId}`,
			background: "semi-auto 策略只给建议，不代替人按按钮",
			assessment: "不派发不会有错，只是这一轮不产出",
			recommendation: `确认 ${goalId} 是现在最该做的，然后派发；否则让它继续排队`,
		},
	};
}

function concurrencyCap(cap: number, waiting: number): TribunalEnvelope {
	return {
		kind: "concurrency_cap",
		subject: "concurrency",
		causeKey: "concurrency_cap",
		action: {
			label: "等一个工位空出来，或调整 scheduler.autoConstraints",
			command: "workbench config set scheduler.policy auto",
		},
		sbar: {
			situation: `已达并发上限（${cap}），${waiting} 个就绪目标等待空闲工位`,
			background: "并发上限是配置值，不是异常",
			assessment: "这是容量信号，不是故障；通常不需要人工介入",
			recommendation: "不用处理；只有长期打满才值得调整上限",
		},
	};
}

export const envelopes = {
	missingDependency,
	deadDependency,
	orphanTask,
	blockedWorkspot,
	invalidBranchName,
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
