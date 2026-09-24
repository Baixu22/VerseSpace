import { describe, expect, test } from "bun:test";
import { shouldNotifyIdle } from "./idle";

/**
 * P0-2：`thresholds.idleNotification` 曾经没有任何消费者。这些用例把它钉住：
 * 只有"有工位在办 + 事件日志整段静默超过阈值"才提醒。
 */
const MINUTE = 60_000;

describe("shouldNotifyIdle（P0-2：空闲通知真的会发）", () => {
	test("有工位在办且静默超过阈值 → 提醒一次", () => {
		const decision = shouldNotifyIdle({
			nowMs: 100 * MINUTE,
			thresholdMs: 15 * MINUTE,
			lastActivityMs: 80 * MINUTE,
			activeWorkspots: 2,
		});
		expect(decision.notify).toBe(true);
		if (decision.notify) {
			expect(decision.severity).toBe("warning");
			expect(decision.message).toContain("2 个工位");
			expect(decision.message).toContain("20 分钟");
		}
	});

	test("没到阈值不提醒", () => {
		const decision = shouldNotifyIdle({
			nowMs: 100 * MINUTE,
			thresholdMs: 15 * MINUTE,
			lastActivityMs: 95 * MINUTE,
			activeWorkspots: 1,
		});
		expect(decision.notify).toBe(false);
	});

	test("没有在办的工位就不提醒——安静的仓库不是新闻", () => {
		const decision = shouldNotifyIdle({
			nowMs: 100 * MINUTE,
			thresholdMs: 15 * MINUTE,
			lastActivityMs: 10 * MINUTE,
			activeWorkspots: 0,
		});
		expect(decision.notify).toBe(false);
	});

	test("阈值不是有效时长时不提醒，也不崩", () => {
		for (const thresholdMs of [0, -1, Number.NaN]) {
			const decision = shouldNotifyIdle({
				nowMs: 100 * MINUTE,
				thresholdMs,
				lastActivityMs: 10 * MINUTE,
				activeWorkspots: 1,
			});
			expect(decision.notify).toBe(false);
		}
	});

	test("空事件日志没有可比时间，不提醒", () => {
		const decision = shouldNotifyIdle({
			nowMs: 100 * MINUTE,
			thresholdMs: 15 * MINUTE,
			lastActivityMs: null,
			activeWorkspots: 1,
		});
		expect(decision.notify).toBe(false);
	});
});
