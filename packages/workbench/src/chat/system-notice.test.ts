import { describe, expect, test } from "bun:test";
import {
	createClaudeRenderState,
	reduceClaudeRenderEvent,
} from "./claude-render-state";
import { noticeFromSystemEvent } from "./system-notice";
import { collapseParts } from "./tool-collapse";

/** The exact payload the frozen legacy Rust test pins (pipeline_scenarios.rs,
 *  `sys_permission_denied_notice`). */
const denial = {
	type: "system",
	subtype: "permission_denied",
	tool_name: "Bash",
	tool_use_id: "toolu_denied",
	decision_reason_type: "classifier",
	decision_reason: "Command writes outside the workspace",
	message: "Permission denied",
};

describe("权限拒绝可见化（TF-0200 follow-up）", () => {
	test("按旧实现的字段与兜底顺序取值，缺字段也要有标签", () => {
		expect(noticeFromSystemEvent(denial)).toEqual({
			severity: "warning",
			label: "Permission denied for Bash",
			body: "Command writes outside the workspace",
		});
		// decision_reason 缺席 → message → decision_reason_type 逐级兜底
		expect(
			noticeFromSystemEvent({ subtype: "permission_denied", message: "nope" }),
		).toEqual({
			severity: "warning",
			label: "Permission denied",
			body: "nope",
		});
		expect(
			noticeFromSystemEvent({
				subtype: "permission_denied",
				tool_name: "Edit",
				decision_reason_type: "rule",
			}),
		).toEqual({
			severity: "warning",
			label: "Permission denied for Edit",
			body: "Decision: rule",
		});
		// 一个字段都没有：仍然是一条能读的警告，不是空白行
		expect(noticeFromSystemEvent({ subtype: "permission_denied" })).toEqual({
			severity: "warning",
			label: "Permission denied",
			body: undefined,
		});
		// 空白字符串不算理由
		expect(
			noticeFromSystemEvent({ subtype: "permission_denied", message: "   " })
				?.body,
		).toBeUndefined();
		// 其它 system 形状不受影响
		expect(noticeFromSystemEvent({ subtype: "init" })).toBeNull();
	});

	test("拒绝不再落到 undecided：判定为 notice 并进入消息部件", () => {
		const state = createClaudeRenderState();
		const result = reduceClaudeRenderEvent(state, denial);
		expect(result.decision).toBe("notice");
		expect(result.decisionKey).toBe("system.permission_denied");
		expect(state.messageParts).toEqual([
			{
				type: "notice",
				severity: "warning",
				label: "Permission denied for Bash",
				body: "Command writes outside the workspace",
			},
		]);
		// 正在流式的那一轮就能看到它，而不是等 done
		const last = result.events.at(-1);
		expect(last && last.type === "parts" ? last.parts : null).toEqual(
			state.messageParts,
		);
	});

	test("通知冲刷折叠组：读文件的先后顺序不被通知打乱", () => {
		const state = createClaudeRenderState();
		reduceClaudeRenderEvent(state, {
			type: "assistant",
			message: {
				content: [
					{
						type: "tool_use",
						id: "r1",
						name: "Read",
						input: { file_path: "a.ts" },
					},
					{
						type: "tool_use",
						id: "r2",
						name: "Read",
						input: { file_path: "b.ts" },
					},
				],
			},
		});
		reduceClaudeRenderEvent(state, denial);
		const streaming = collapseParts(state.messageParts, { streaming: true });
		const stored = collapseParts(state.messageParts, { streaming: false });
		// 组必须排在通知之前 —— 与 tool-collapse 的边界规则一致
		expect(streaming.map((part) => part.type)).toEqual([
			"collapsed-group",
			"notice",
		]);
		expect(stored.map((part) => part.type)).toEqual([
			"collapsed-group",
			"notice",
		]);
		// 折叠是纯展示：工具事实仍在组里，通知没被吞掉
		expect(streaming.at(-1)).toMatchObject({ type: "notice" });
	});
});
