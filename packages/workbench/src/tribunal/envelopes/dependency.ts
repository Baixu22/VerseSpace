import type { TribunalEnvelope } from "../../types/tribunal";

export function missingDependency(
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

export function deadDependency(
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
