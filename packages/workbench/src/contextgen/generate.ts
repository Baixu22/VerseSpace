import { isAbsolute, join } from "node:path";
import type { Blackboard } from "../blackboard";
import { writeFileAtomic } from "../fs/atomic";
import { isWorldEvent, type WorkbenchEvent } from "../types/event";
import { renderContext } from "./render";

export interface GenerateResult {
	workspotId: string;
	ok: boolean;
	path?: string;
	reason?: string;
}

function taskOf(workspot: {
	currentTask?: string;
	primaryTask: string;
}): string {
	return workspot.currentTask ?? workspot.primaryTask;
}

function selectEvents(
	events: WorkbenchEvent[],
	filter: { tags: string[]; lastN: number } | undefined,
): WorkbenchEvent[] {
	const lastN = filter?.lastN ?? 10;
	const worldEvents = events.filter(isWorldEvent);
	if (!filter || filter.tags.length === 0) {
		return worldEvents.slice(-lastN);
	}
	const tagged = worldEvents.filter((event) => {
		const tags = (event.payload as { tags?: unknown } | null)?.tags;
		return (
			Array.isArray(tags) &&
			tags.some((tag) => filter.tags.includes(String(tag)))
		);
	});
	return tagged.slice(-lastN);
}

/**
 * Render and write `.agent-context.md` into the workspot's worktree. The data
 * layer is the only source: goal, its context_needs (decisions, interfaces),
 * filtered events, and known conflicts.
 */
export async function generateContext(
	bb: Blackboard,
	workspotId: string,
): Promise<GenerateResult> {
	const workspot = await bb.state.workspots.get(workspotId);
	if (!workspot) {
		return { workspotId, ok: false, reason: "workspot 不存在" };
	}
	const taskId = taskOf(workspot);
	const goal = await bb.goals.get(taskId);
	if (!goal) {
		return { workspotId, ok: false, reason: `任务目标 ${taskId} 不存在` };
	}

	const needs = workspot.contextNeeds;
	const decisions = (await bb.decisions.list()).filter((decision) =>
		needs.decisions.includes(decision.id),
	);
	const interfaces = (await bb.interfaces.list()).filter((entry) =>
		needs.interfaces.includes(entry.key),
	);
	const events = selectEvents(await bb.events.all(), needs.eventsFilter);
	const conflicts = await bb.state.conflicts.list();
	const { eventLineChars } = (await bb.config.load()).contextgen;

	const markdown = renderContext({
		workspot,
		goal,
		decisions,
		interfaces,
		projectRoot: bb.projectRoot,
		events,
		conflicts,
		eventLineChars,
	});

	// worktreePath may be recorded relative to the project root (e.g. ../ws-wt)
	const worktree = isAbsolute(workspot.worktreePath)
		? workspot.worktreePath
		: join(bb.projectRoot, workspot.worktreePath);
	const target = join(worktree, ".agent-context.md");
	await writeFileAtomic(target, markdown);
	return { workspotId, ok: true, path: target };
}

/**
 * Refresh every workspot; unresolvable ones are reported, never fatal.
 * 预留导出（仅测试消费，2026-09-13 审计 §4.2）：TF-0036 的「全工位刷新」
 * 入口，生产路径按需单工位生成，不走全量。
 */
export async function generateAllContexts(
	bb: Blackboard,
): Promise<GenerateResult[]> {
	const workspots = await bb.state.workspots.list();
	return Promise.all(
		workspots.map((workspot) => generateContext(bb, workspot.id)),
	);
}
