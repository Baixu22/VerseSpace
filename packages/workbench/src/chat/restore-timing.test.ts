import { describe, expect, test } from "bun:test";
import type { WorkbenchEvent } from "../types/event";
import { foldRestoreTimings } from "./restore-timing";
import type { StoredMessage } from "./threads";

const NOW = Date.parse("2026-09-07T12:00:00Z");
const at = (seconds: number) => new Date(NOW + seconds * 1_000).toISOString();

function restored(
	threadId: string,
	seconds: number,
	resumeCardVisible?: boolean,
	lastMessageId: string | null = null,
): WorkbenchEvent {
	return {
		id: `restore-${threadId}-${seconds}`,
		timestamp: at(seconds),
		source: "threads",
		type: "thread.restored",
		payload: { threadId, resumeCardVisible, lastMessageId },
	};
}

function user(id: string, seconds: number): StoredMessage {
	return { id, role: "user", text: "继续", at: at(seconds) };
}

describe("恢复到首条消息（TF-0126）", () => {
	test("分组取中位数，只计恢复后的第一条用户消息", () => {
		const result = foldRestoreTimings(
			[
				restored("a", -600, true),
				restored("b", -500, true),
				restored("c", -400, false),
				restored("d", -300, false),
			],
			new Map([
				[
					"a",
					[
						{ ...user("reply", -599), role: "assistant" },
						user("a1", -580),
						user("a2", -550),
					],
				],
				["b", [user("b1", -474)]],
				["c", [user("c1", -390)]],
				["d", [user("d1", -290)]],
			]),
			NOW,
		);
		expect(result).toEqual({
			windowDays: 7,
			withCard: { samples: 2, medianMs: 23_000 },
			withoutCard: { samples: 2, medianMs: 10_000 },
			unknownCard: { samples: 0, medianMs: null },
			incomplete: 0,
			medianChangeRatio: 1.3,
			exceeds20Percent: true,
		});
	});

	test("缺少曝光记录不当无卡；缺少消息边界不猜第一条", () => {
		const legacy = restored("legacy", -300, false);
		legacy.payload = { threadId: "legacy", resumeCardVisible: false };
		const result = foldRestoreTimings(
			[restored("unknown", -400), legacy, restored("empty", -200, true)],
			new Map([
				["unknown", [user("u1", -390)]],
				["legacy", [user("l1", -290)]],
			]),
			NOW,
		);
		expect(result.unknownCard).toEqual({ samples: 1, medianMs: 10_000 });
		expect(result.withoutCard.samples).toBe(0);
		expect(result.incomplete).toBe(2);
		expect(result.medianChangeRatio).toBeNull();
		expect(result.exceeds20Percent).toBeNull();
	});

	test("切走即结束，返回后的消息不借给上一次恢复", () => {
		const switched = { ...restored("b", -590), type: "thread.switch" };
		const result = foldRestoreTimings(
			[restored("a", -600, true), switched, restored("a", -500, false, "a1")],
			new Map([["a", [user("a1", -550), user("a2", -480)]]]),
			NOW,
		);
		expect(result.withCard.samples).toBe(0);
		expect(result.withoutCard).toEqual({ samples: 1, medianMs: 20_000 });
		expect(result.incomplete).toBe(1);
	});

	test("同线程 leave 关闭窗口，其他线程的 leave 不关闭", () => {
		const result = foldRestoreTimings(
			[
				restored("a", -600, true),
				{ ...restored("other", -599), type: "thread.left" },
				restored("b", -500, false),
				{ ...restored("b", -499), type: "thread.left" },
			],
			new Map([
				["a", [user("a1", -590)]],
				["b", [user("b1", -490)]],
			]),
			NOW,
		);
		expect(result.withCard.samples).toBe(1);
		expect(result.withoutCard.samples).toBe(0);
		expect(result.incomplete).toBe(1);
	});

	test("延迟观测不跳过已发出的第一条，历史被删除也不猜边界", () => {
		const result = foldRestoreTimings(
			[
				restored("late", -300, true, "base"),
				restored("deleted", -200, false, "gone"),
			],
			new Map([
				[
					"late",
					[user("base", -400), user("first", -301), user("second", -290)],
				],
				["deleted", [user("new", -100)]],
			]),
			NOW,
		);
		expect(result.incomplete).toBe(2);
		expect(result.withCard.samples + result.withoutCard.samples).toBe(0);
	});

	test("近七天之外不进入比较，时间不合法时保留未配对计数", () => {
		const result = foldRestoreTimings(
			[
				restored("old", -8 * 86_400, true),
				restored("invalid", -300, false),
				restored("future", 100, true),
			],
			new Map([
				["old", [user("old1", -8 * 86_400 + 10)]],
				["invalid", [{ ...user("bad", -290), at: "invalid" }]],
				["future", [user("future1", 110)]],
			]),
			NOW,
		);
		expect(result.incomplete).toBe(1);
		expect(result.withCard.samples).toBe(0);
	});

	test("20% 边界与零基线：不四舍五入过门，不除以零", () => {
		const events = [restored("a", -200, true), restored("b", -100, false)];
		const messages = new Map([
			["a", [user("a1", -188)]],
			["b", [user("b1", -90)]],
		]);
		expect(foldRestoreTimings(events, messages, NOW).exceeds20Percent).toBe(
			false,
		);
		messages.set("a", [user("a1", -187.999)]);
		expect(foldRestoreTimings(events, messages, NOW).exceeds20Percent).toBe(
			true,
		);
		messages.set("b", [user("b1", -100)]);
		const zero = foldRestoreTimings(events, messages, NOW);
		expect(zero.withoutCard).toEqual({ samples: 1, medianMs: 0 });
		expect(zero.medianChangeRatio).toBeNull();
		expect(zero.exceeds20Percent).toBeNull();
	});
});
