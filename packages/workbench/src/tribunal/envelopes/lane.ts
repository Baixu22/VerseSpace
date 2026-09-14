import type { TribunalEnvelope } from "../../types/tribunal";

/**
 * Per-lane distress (TF-0084). Three lines, each one a *shape* of failure a
 * human can act on — not a threshold someone has to remember to watch:
 * - the cache stopped absorbing, so the lane is paying full price for context
 *   it has already read;
 * - context is almost entirely tool output, so the lane is drowning in what
 *   it asked for rather than thinking;
 * - the lane has failed repeatedly in a row, which is stuck, not unlucky.
 *
 * The `causeKey` intentionally names the lane AND the line: the same lane
 * tripping two different lines is two different decisions.
 */
export function metricCacheMiss(
	workspot: string,
	hitRate: number,
): TribunalEnvelope {
	return {
		kind: "metric_cache_miss",
		subject: workspot,
		causeKey: `metric_cache_miss:${workspot}`,
		action: {
			label: `看一眼 ${workspot} 是不是在反复重读同一批文件`,
			command: `workbench metrics`,
		},
		sbar: {
			situation: `工位 ${workspot} 的缓存命中率只有 ${(hitRate * 100).toFixed(0)}%`,
			background: "命中率低意味着几乎每一轮都在为已经读过的上下文重新付账",
			assessment:
				"token 开销会随轮次线性上涨，压缩会提前到来，产出质量随之下滑",
			recommendation: `先看 ${workspot} 的工具调用是不是在扫整个目录；是的话收窄范围，否则让这轮跑完再看`,
		},
	};
}

export function metricToolBloat(
	workspot: string,
	share: number,
): TribunalEnvelope {
	return {
		kind: "metric_tool_bloat",
		subject: workspot,
		causeKey: `metric_tool_bloat:${workspot}`,
		action: {
			label: `收窄 ${workspot} 的工具输出（加 limit／只取需要的字段）`,
			command: `workbench metrics`,
		},
		sbar: {
			situation: `工位 ${workspot} 的上下文有 ${(share * 100).toFixed(0)}% 来自工具结果`,
			background: "工具结果占比过高时，模型看到的基本是它自己刚才要来的数据",
			assessment: "有效推理空间被挤占，同样的问题要更多轮才能收敛",
			recommendation: `给 ${workspot} 的大输出工具加行数或字段限制；这一步省下的 token 比换模型更直接`,
		},
	};
}

export function metricSuspend(
	workspot: string,
	failures: number,
): TribunalEnvelope {
	return {
		kind: "metric_suspend",
		subject: workspot,
		causeKey: `metric_suspend:${workspot}`,
		action: {
			label: `停掉 ${workspot} 或换一个任务给它（连续失败 ${failures} 次）`,
			command: `workbench ws reassign ${workspot} --task <goal-id>`,
		},
		sbar: {
			situation: `工位 ${workspot} 连续 ${failures} 次失败`,
			background:
				"连续失败和累计失败不是一回事：前者说明这一轮的前提已经不成立",
			assessment: "继续重试只是重复烧 token，且每次失败都会把上下文推向压缩",
			recommendation: `别再重试 ${workspot}；先看最后一次报错，决定是换任务还是改前提`,
		},
	};
}
