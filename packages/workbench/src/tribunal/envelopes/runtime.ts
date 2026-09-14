import type { TribunalEnvelope } from "../../types/tribunal";

/**
 * R2 / TF-0079 合并安全网。两条线，各自是一次不同的决定：
 * - `git merge-tree` 判出的**真冲突**——真做了一次合并，所以没有假阳性；
 * - 写集重叠且该文件**近期罕有共享**——稀有性本身才是信号，常共享的文件
 *   每次都报只会把人训练成忽略这个通道。
 *
 * 两者都只提示、不阻塞：合并时刻是错误的用力点，功夫在上游（把改动保持得小）。
 */
export function mergeConflictPredicted(
	a: string,
	b: string,
	paths: string[],
): TribunalEnvelope {
	const list = paths.slice(0, 5).join("、");
	const more = paths.length > 5 ? ` 等 ${paths.length} 处` : "";
	return {
		kind: "merge_conflict_predicted",
		subject: `${a}↔${b}`,
		causeKey: `merge_conflict_predicted:${a}:${b}`,
		action: {
			label: `在 ${a} 与 ${b} 合并前先化解 ${list}`,
			command: `git merge-tree --write-tree --name-only ${a} ${b}`,
		},
		sbar: {
			situation: `${a} 与 ${b} 真的合不拢：${list}${more}`,
			background:
				"这条来自一次真实合并（git merge-tree --write-tree），不是相似度启发式——预测到的冲突就是真冲突",
			assessment:
				"两边继续各自往前跑，冲突面只会更大，且要在合并那一刻一次性付出",
			recommendation: `把 ${list} 的改动拆小，或先合掉一边；越早处理越便宜`,
		},
		evidence: {
			paths,
			commands: [`git merge-tree --write-tree --name-only ${a} ${b}`],
		},
	};
}

export function writeOverlapRare(
	a: string,
	b: string,
	path: string,
	authors: string[],
): TribunalEnvelope {
	return {
		kind: "write_overlap_rare",
		subject: `${a}↔${b}`,
		causeKey: `write_overlap_rare:${a}:${b}:${path}`,
		action: {
			label: `确认 ${path} 该由哪一边改，或把它拆成两个文件`,
			command: `git log --oneline -n 10 -- ${path}`,
		},
		sbar: {
			situation: `${a} 与 ${b} 都在改 ${path}，而这个文件近期只有 ${authors.length} 位作者碰过`,
			background:
				"两个写者落在同一个文件上，只有在这个文件并非日常共享时才是新闻；常共享的文件不值得每次都报",
			assessment:
				"git 还没判出冲突，但重叠本身说明改动正在往同一个地方挤，晚处理代价更高",
			recommendation: `先问一句 ${path} 归谁改；若两边都要改，把它拆开再继续`,
		},
		evidence: { paths: [path] },
	};
}

/**
 * issue #6 item 12 — 两条「管道自己出事了」的卡片。
 *
 * 在此之前 `dispatch_failed` 与 `agent_crashloop` 只作为通用日志行出现在
 * `workbench log` 与 `/api/state` 活动流里，派发失败与崩溃循环没有专门的
 * 可观测面，容易被淹没。它们与其他卡片的区别在于：**不是预测，是已经发生
 * 的事实**——所以文案里说「试过了、失败了」，而不是「可能会失败」。
 */
export function dispatchFailed(
	goalId: string,
	workspotId: string | undefined,
	reason: string,
): TribunalEnvelope {
	return {
		kind: "dispatch_failed",
		subject: goalId,
		causeKey: `dispatch_failed:${goalId}:${workspotId ?? "-"}`,
		action: {
			label: `看 ${goalId} 这次为什么没起来，修掉后重新派发`,
			command: `workbench dispatch ${goalId}${workspotId ? ` ${workspotId}` : ""}`,
		},
		sbar: {
			situation: `派发 ${goalId} 到 ${workspotId ?? "空闲工位"} 失败：${reason}`,
			background: "派发入口没有完成目标检查、worktree 创建或工位绑定",
			assessment: "这一轮未开始执行；反复失败会使队列停滞",
			recommendation: `先判断是环境问题还是前提问题；环境修好后重跑上面的命令，下一轮调度也会自己重试`,
		},
	};
}

export function agentCrashloop(
	workspotId: string,
	label: string,
): TribunalEnvelope {
	return {
		kind: "agent_crashloop",
		subject: workspotId,
		causeKey: `agent_crashloop:${workspotId}:${label}`,
		action: {
			label: `读 ${workspotId} 最近三次崩溃的日志，再决定重派还是改前提`,
			command: `workbench log --tail 50`,
		},
		sbar: {
			situation: `工位 ${workspotId}（${label}）60 秒内异常退出 3 次，熔断已暂停派发`,
			background:
				"连续崩溃说明前提不成立，不是运气差；熔断窗口 60 秒，窗口内不再派发这个工位",
			assessment:
				"不处理的话该工位在窗口内一直不接活；崩溃原因没修的话窗口过后会再次熔断，变成「崩三次停一分钟」的循环",
			recommendation: `先读第一次崩溃的报错——那才是根因；修掉后再派发，熔断会自行放开`,
		},
		evidence: { commands: ["workbench log --tail 50"] },
	};
}
