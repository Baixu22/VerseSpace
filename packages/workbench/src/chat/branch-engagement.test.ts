/**
 * 分支行展开/点击读数的折叠行为（TF-0199，fit 指标 7）：分母是渲染
 * （resume_card_shown 的行标签），分子是同恢复窗内带标签的展开/点击。
 * 配对单位与熔断器一致：restore 开窗、switch/left/下次恢复关窗。
 */
import { expect, test } from "bun:test";
import type { WorkbenchEvent } from "../types/event";
import { foldBranchEngagement } from "./branch-engagement";

let seq = 0;
function ev(
	type: string,
	threadId: string,
	payload: Record<string, unknown> = {},
) {
	seq += 1;
	return {
		timestamp: new Date(Date.UTC(2026, 8, 19, 0, 0, seq)).toISOString(),
		source: "thread",
		type,
		eventSeq: seq,
		payload: { threadId, ...payload },
	} as WorkbenchEvent;
}

const restore = (threadId: string) => ev("thread.restored", threadId);
const shown = (threadId: string, rows: string[]) =>
	ev("thread.resume_card_shown", threadId, { branchRows: rows });
const expand = (threadId: string, label: string) =>
	ev("thread.resume_action", threadId, { action: "resume_fact_opened", label });
const click = (threadId: string, label: string) =>
	ev("thread.resume_action", threadId, {
		action: "resume_branch_opened",
		label,
	});
const plain = (threadId: string) =>
	ev("thread.resume_action", threadId, { action: "resume_fact_opened" });

test("没有任何渲染：ratio=null——不可计算不是 0", () => {
	const stats = foldBranchEngagement([restore("t"), expand("t", "branch:b1")]);
	expect(stats.branchRowsShown).toBe(0);
	expect(stats.ratio).toBeNull();
});

test("渲染 2 行未消费：分母 2、分子 0、ratio=0——『人们很少回头』可测", () => {
	const stats = foldBranchEngagement([
		restore("t"),
		shown("t", ["branch:b1", "branch:b2"]),
	]);
	expect(stats.restoresWithBranchRows).toBe(1);
	expect(stats.branchRowsShown).toBe(2);
	expect(stats.branchRowsEngaged).toBe(0);
	expect(stats.ratio).toBe(0);
});

test("展开与指针点击都计入分子；未渲染的行不参与归属", () => {
	const stats = foldBranchEngagement([
		restore("t"),
		shown("t", ["branch:b1", "branch:b2"]),
		expand("t", "branch:b1"),
		click("t", "branch:b2"),
		expand("t", "branch:b9"), // 没渲染过的行：不进分子
	]);
	expect(stats.branchRowsEngaged).toBe(2);
	expect(stats.ratio).toBe(1);
});

test("无标签的展开（文件行 / 旧数据）不进分子", () => {
	const stats = foldBranchEngagement([
		restore("t"),
		shown("t", ["branch:b1"]),
		plain("t"),
	]);
	expect(stats.branchRowsEngaged).toBe(0);
	expect(stats.ratio).toBe(0);
});

test("窗口配对：切走后的动作、别的线程的窗口都不算数", () => {
	const switchedAway = foldBranchEngagement([
		restore("t"),
		shown("t", ["branch:b1"]),
		ev("thread.switch", "t", { fromThreadId: null }),
		expand("t", "branch:b1"),
	]);
	expect(switchedAway.branchRowsEngaged).toBe(0);

	const otherThread = foldBranchEngagement([
		restore("t1"),
		restore("t2"),
		shown("t1", ["branch:b1"]),
		expand("t2", "branch:b1"),
	]);
	expect(otherThread.branchRowsEngaged).toBe(0);
	expect(otherThread.ratio).toBe(0);
});

test("同一窗内重复渲染同一行只计一次；跨窗重新渲染重新计数", () => {
	const oneWindow = foldBranchEngagement([
		restore("t"),
		shown("t", ["branch:b1"]),
		shown("t", ["branch:b1", "branch:b1"]),
	]);
	expect(oneWindow.branchRowsShown).toBe(1);

	const twoWindows = foldBranchEngagement([
		restore("t"),
		shown("t", ["branch:b1"]),
		expand("t", "branch:b1"),
		restore("t"),
		shown("t", ["branch:b1"]),
	]);
	expect(twoWindows.restoresWithBranchRows).toBe(2);
	expect(twoWindows.branchRowsShown).toBe(2);
	expect(twoWindows.branchRowsEngaged).toBe(1);
	expect(twoWindows.ratio).toBe(0.5);
});

test("历史末尾未关窗的展示也结算（最近一次恢复可读）", () => {
	const stats = foldBranchEngagement([
		restore("t"),
		shown("t", ["branch:b1"]),
		click("t", "branch:b1"),
	]);
	expect(stats.branchRowsShown).toBe(1);
	expect(stats.branchRowsEngaged).toBe(1);
	expect(stats.ratio).toBe(1);
});
