/**
 * 分支行展开/点击读数（TF-0199，D3-Q2 fit 指标 7）：
 * 「渲染的分支行中被展开或指针被点的比例」。
 *
 * 分母来自 `thread.resume_card_shown`（UI 渲染出带分支行的恢复卡时落一条，
 * 带本次展示的 `branch:<threadId>` 行标签）——渲染了才计数，GET 不替 UI
 * 编造展示。分子是同一恢复窗内 `thread.resume_action` 的展开/点击动作里
 * 携带的行标签（`label`，TF-0199 起随动作记录）。没有标签的动作（文件行、
 * 旧数据）不参与归属。
 *
 * 归属单位与熔断器（circuit.ts）一致：`thread.restored` 开窗，
 * `thread.switch` / `thread.left` / 下次恢复关窗结算——一次展示和它窗内
 * 的消费在同一窗配对，跨窗的动作不算数。
 */
import type { WorkbenchEvent } from "../types/event";

const ENGAGEMENT_ACTIONS = new Set([
	"resume_fact_opened",
	"resume_branch_opened",
]);

export interface BranchEngagementStats {
	/** 出现过分支行的恢复窗数（≥1 行被渲染）。 */
	restoresWithBranchRows: number;
	/** 被渲染过的分支行总数（每窗按去重后的行标签计）。 */
	branchRowsShown: number;
	/** 其中同窗内被展开或被点过的行数（shown ∩ engaged）。 */
	branchRowsEngaged: number;
	/** engaged / shown；null = 还没有任何分支行被渲染过（不可计算，不是 0）。 */
	ratio: number | null;
}

function payloadOf(event: WorkbenchEvent): Record<string, unknown> {
	return event.payload && typeof event.payload === "object"
		? (event.payload as Record<string, unknown>)
		: {};
}

function stringOf(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function labelsOf(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(row): row is string => typeof row === "string" && row.trim().length > 0,
	);
}

interface ObservationWindow {
	shown: Set<string>;
	engaged: Set<string>;
}

export function foldBranchEngagement(
	events: WorkbenchEvent[],
): BranchEngagementStats {
	let restoresWithBranchRows = 0;
	let branchRowsShown = 0;
	let branchRowsEngaged = 0;
	const open = new Map<string, ObservationWindow>();
	const close = (threadId: string): void => {
		const window = open.get(threadId);
		if (!window) return;
		open.delete(threadId);
		if (window.shown.size === 0) return;
		restoresWithBranchRows += 1;
		branchRowsShown += window.shown.size;
		let engaged = 0;
		for (const label of window.engaged) {
			if (window.shown.has(label)) engaged += 1;
		}
		branchRowsEngaged += engaged;
	};
	for (const event of events) {
		if (event.type === "thread.switch" || event.type === "thread.left") {
			for (const threadId of [...open.keys()]) close(threadId);
			continue;
		}
		const payload = payloadOf(event);
		const threadId = stringOf(payload.threadId);
		if (event.type === "thread.restored") {
			if (threadId) {
				close(threadId);
				// 新的恢复 = 该线程新的观察窗。
				open.set(threadId, { shown: new Set(), engaged: new Set() });
			}
			continue;
		}
		if (!threadId) continue;
		if (event.type === "thread.resume_card_shown") {
			const window = open.get(threadId);
			if (!window) continue;
			for (const label of labelsOf(payload.branchRows)) {
				window.shown.add(label);
			}
			continue;
		}
		if (event.type !== "thread.resume_action") continue;
		if (!ENGAGEMENT_ACTIONS.has(stringOf(payload.action) ?? "")) continue;
		const label = stringOf(payload.label);
		if (!label) continue;
		open.get(threadId)?.engaged.add(label);
	}
	for (const threadId of [...open.keys()]) close(threadId);

	return {
		restoresWithBranchRows,
		branchRowsShown,
		branchRowsEngaged,
		ratio:
			branchRowsShown > 0
				? Number((branchRowsEngaged / branchRowsShown).toFixed(4))
				: null,
	};
}
