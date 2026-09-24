import type { TribunalEnvelope } from "../../types/tribunal";

export function staleQueueEntries(ids: string[]): TribunalEnvelope {
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

export function noIdleWorkspot(readyCount: number): TribunalEnvelope {
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

export function dispatchSuggestion(
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

export function concurrencyCap(cap: number, waiting: number): TribunalEnvelope {
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
