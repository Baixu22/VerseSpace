import { describe, expect, test } from "bun:test";
import { collectDecisionPoints } from "./ledger";
import type { StoredMessage } from "./threads";

function msg(
	id: string,
	role: "user" | "assistant",
	text: string,
	variants?: string[],
): StoredMessage {
	return {
		id,
		role,
		text,
		at: new Date().toISOString(),
		...(variants ? { variants } : {}),
	};
}

describe("安静的决策账本（TF-0095）", () => {
	test("无分歧时账本为空——UI 完全不渲染", () => {
		const points = collectDecisionPoints(
			[msg("m1", "user", "一问"), msg("m2", "assistant", "一答")],
			{},
		);
		expect(points).toEqual([]);
	});

	test("分叉计数与备选变体都成为决策点，按消息顺序排列", () => {
		const points = collectDecisionPoints(
			[
				msg("m1", "user", "一问"),
				msg("m2", "assistant", "一答", ["备选 A"]),
				msg("m3", "user", "二问"),
				msg("m4", "assistant", "二答"),
			],
			{ forks: { m3: 2 } },
		);
		expect(points).toEqual([
			{ messageId: "m2", kind: "variant", count: 1, preview: "一答" },
			{ messageId: "m3", kind: "fork", count: 2, preview: "二问" },
		]);
	});

	test("锚点消息已被截掉时账本仍记录这次分歧", () => {
		const points = collectDecisionPoints([msg("m2", "assistant", "一答")], {
			forks: { "m-gone": 1 },
		});
		expect(points).toHaveLength(1);
		expect(points[0]!.kind).toBe("fork");
		expect(points[0]!.messageId).toBe("m-gone");
	});
});
