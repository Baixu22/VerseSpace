import type { TribunalEnvelope } from "../../types/tribunal";

export function checkpointWithoutPolicy(
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

export function checkpointAwaitingReview(cpId: string): TribunalEnvelope {
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
