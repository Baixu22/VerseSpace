import { isAbsolute, join } from "node:path";
import type { Decision } from "../types/decision";
import { isWorldEvent, type WorkbenchEvent } from "../types/event";
import type { Goal } from "../types/goal";
import type { RegistryEntry } from "../types/interface-registry";
import type { Conflict } from "../types/state";
import type { Workspot } from "../types/workspot";

export interface ContextInput {
	workspot: Workspot;
	goal: Goal;
	decisions: Decision[];
	interfaces: RegistryEntry[];
	projectRoot: string;
	events: WorkbenchEvent[];
	conflicts: Conflict[];
}

function eventLine(event: WorkbenchEvent): string {
	const payload = event.payload as { tags?: unknown; summary?: unknown } | null;
	const summary =
		typeof payload?.summary === "string"
			? payload.summary
			: JSON.stringify(event.payload);
	return `- [${event.timestamp}] ${event.type}: ${summary}`;
}

/**
 * Pure renderer for `.agent-context.md` (skeleton module 7). Empty sections are
 * omitted entirely so the agent never sees placeholder noise.
 */
export function renderContext(input: ContextInput): string {
	const lines: string[] = [];
	const {
		workspot,
		goal,
		decisions,
		interfaces,
		projectRoot,
		events: inputEvents,
		conflicts,
	} = input;
	const events = inputEvents.filter(isWorldEvent);

	lines.push("# 工作上下文（自动生成，请勿手动编辑）");
	lines.push("");
	lines.push("## 你的任务");
	lines.push(`${goal.title}（${goal.id}）`);
	lines.push(
		`工位：${workspot.id}（分支 ${workspot.branch}，绑定 ${workspot.binding}）`,
	);
	lines.push("");

	if (goal.acceptance.length > 0) {
		lines.push("## 验收条件");
		for (const criterion of goal.acceptance) {
			const strategy = criterion.verification?.strategy;
			lines.push(
				`- ${criterion.assertion}${strategy ? `〔验证：${strategy}〕` : ""}`,
			);
		}
		lines.push("");
	}

	if (decisions.length > 0) {
		lines.push("## 必须遵守的架构决策");
		for (const decision of decisions) {
			lines.push(
				`- ${decision.title}：${decision.rationale}（${decision.author}）`,
			);
		}
		lines.push("");
	}

	if (interfaces.length > 0) {
		lines.push("## 可用的接口定义");
		for (const entry of interfaces) {
			const absolute = isAbsolute(entry.canonicalPath)
				? entry.canonicalPath
				: join(projectRoot, entry.canonicalPath);
			lines.push(
				`- ${entry.key} → ${entry.canonicalPath}（v${entry.version}）`,
			);
			lines.push(`  文件路径: ${absolute}`);
		}
		lines.push("");
	}

	if (events.length > 0) {
		lines.push("## 最近的相关事件");
		for (const event of events) {
			lines.push(eventLine(event));
		}
		lines.push("");
	}

	if (conflicts.length > 0) {
		lines.push("## 当前已知冲突");
		for (const conflict of conflicts) {
			lines.push(`- [${conflict.kind}] ${conflict.detail}`);
		}
		lines.push("");
	}

	lines.push("## 约束");
	lines.push("- src/contracts/ 下的文件是跨模块契约，修改前请说明理由");
	lines.push(
		"- 完成有意义的阶段时，请在 .workbench/checkpoints/staging/ 创建 checkpoint 文件",
	);
	lines.push("");

	return lines.join("\n");
}
