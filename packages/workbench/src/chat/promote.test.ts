import { describe, expect, test } from "bun:test";
import {
	collectSignals,
	countUserTurns,
	deriveTitle,
	evaluatePromotion,
	hoursSinceLastMessage,
	NEXT_DAY_RESUME_HOURS,
	PROMOTION_TURNS,
	promotionPatch,
	UNNAMED_TITLE,
} from "./promote";
import type { StoredMessage } from "./threads";

function msg(
	role: "user" | "assistant",
	text: string,
	at?: string,
): StoredMessage {
	return {
		id: `m-${Math.random().toString(36).slice(2, 8)}`,
		role,
		text,
		at: at ?? new Date().toISOString(),
	};
}

describe("evaluatePromotion", () => {
	test("未命名 + 信号命中 → 直接晋升（不提议，ADR-0009）", () => {
		const verdict = evaluatePromotion({
			title: UNNAMED_TITLE,
			userTurnCount: 8,
			signals: [{ kind: "turns-crossed", turns: 8 }],
		});
		expect(verdict.promote).toBe(true);
		expect(verdict.signals).toHaveLength(1);
		expect(verdict.reason).toBeUndefined();
	});

	test("已命名的对话不再晋升（不覆盖用户可能改过的标题）", () => {
		const verdict = evaluatePromotion({
			title: "我的调试记录",
			userTurnCount: 100,
			signals: [{ kind: "turns-crossed", turns: 100 }],
		});
		expect(verdict.promote).toBe(false);
		expect(verdict.reason).toBe("already-named");
	});

	test("无信号不晋升", () => {
		const verdict = evaluatePromotion({
			title: UNNAMED_TITLE,
			userTurnCount: 1,
			signals: [],
		});
		expect(verdict.promote).toBe(false);
		expect(verdict.reason).toBe("no-signal");
	});
});

describe("deriveTitle", () => {
	test("取第一条用户消息", () => {
		const title = deriveTitle([
			msg("assistant", "你好"),
			msg("user", "帮我修 rollback 的测试"),
		]);
		expect(title).toBe("帮我修 rollback 的测试");
	});

	test("超过 24 字裁断并加省略号", () => {
		const title = deriveTitle([
			msg("user", "这是一条非常非常非常非常非常长的第一句话超过二十四个字了"),
		]);
		expect(title.length).toBe(25); // 24 字 + …
		expect(title.endsWith("…")).toBe(true);
	});

	test("空对话回退到未命名", () => {
		expect(deriveTitle([])).toBe(UNNAMED_TITLE);
		expect(deriveTitle([msg("assistant", "只有助手")])).toBe(UNNAMED_TITLE);
	});

	test("首尾空白被裁掉", () => {
		expect(
			deriveTitle([msg("user", "   带空白   ")]).startsWith("带空白"),
		).toBe(true);
	});
});

describe("触发信号", () => {
	test("countUserTurns 只数用户消息", () => {
		const turns = countUserTurns([
			msg("user", "1"),
			msg("assistant", "a"),
			msg("user", "2"),
			msg("assistant", "b"),
			msg("user", "3"),
		]);
		expect(turns).toBe(3);
	});

	test(`跨过 ${PROMOTION_TURNS} 轮触发 turns-crossed`, () => {
		const below = collectSignals(
			Array.from({ length: PROMOTION_TURNS - 1 }, (_, i) =>
				msg("user", `u${i}`),
			),
		);
		expect(below).toEqual([]);

		const at = collectSignals(
			Array.from({ length: PROMOTION_TURNS }, (_, i) => msg("user", `u${i}`)),
		);
		expect(at).toEqual([{ kind: "turns-crossed", turns: PROMOTION_TURNS }]);
	});

	test(`距上一条消息 ≥ ${NEXT_DAY_RESUME_HOURS} 小时触发 next-day-resume`, () => {
		const now = new Date("2026-09-01T12:00:00Z");
		const stale = collectSignals(
			[msg("user", "昨天的工作", "2026-08-30T12:00:00Z")],
			{ now },
		);
		expect(stale).toEqual([{ kind: "next-day-resume", awayHours: 48 }]);

		const fresh = collectSignals(
			[msg("user", "刚刚的消息", "2026-09-01T11:00:00Z")],
			{ now },
		);
		expect(fresh).toEqual([]);
	});

	test("首轮（无消息）不算恢复", () => {
		expect(hoursSinceLastMessage([])).toBe(0);
	});

	test("二次分叉信号由调用方传入并合并", () => {
		const signals = collectSignals([], {
			extraSignals: [{ kind: "second-fork", atMessageId: "m-abc" }],
		});
		expect(signals).toEqual([{ kind: "second-fork", atMessageId: "m-abc" }]);
	});

	test("非法时间戳降级为 0，不抛错", () => {
		expect(hoursSinceLastMessage([msg("user", "x", "not-a-date")])).toBe(0);
	});
});

describe("promotionPatch", () => {
	test("产出标题 + 可观测的晋升记录，不改消息（纯函数）", () => {
		const messages = [msg("user", "调研上下文回退方案")];
		const snapshot = JSON.stringify(messages);
		const patch = promotionPatch(messages, [
			{ kind: "turns-crossed", turns: 8 },
		]);
		expect(patch.title).toBe("调研上下文回退方案");
		expect(patch.promotion.title).toBe("调研上下文回退方案");
		expect(patch.promotion.signals).toEqual([
			{ kind: "turns-crossed", turns: 8 },
		]);
		expect(new Date(patch.promotion.at).toString()).not.toBe("Invalid Date");
		// 对话本身零变化
		expect(JSON.stringify(messages)).toBe(snapshot);
	});
});
