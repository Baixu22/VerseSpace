import { describe, expect, test } from "bun:test";
import {
	buildVariants,
	clampFanout,
	FANOUT_DEFAULT,
	FANOUT_MAX,
} from "./fanout";

describe("自动扇出变体（TF-0094）", () => {
	describe("clampFanout", () => {
		test("默认 1；整数夹取到 [1, 3]；非法值回退默认", () => {
			expect(clampFanout(undefined)).toBe(FANOUT_DEFAULT);
			expect(clampFanout(1)).toBe(1);
			expect(clampFanout(2)).toBe(2);
			expect(clampFanout(99)).toBe(FANOUT_MAX);
			expect(clampFanout(0)).toBe(FANOUT_DEFAULT);
			expect(clampFanout(-3)).toBe(FANOUT_DEFAULT);
			expect(clampFanout(1.5)).toBe(FANOUT_DEFAULT);
			expect(clampFanout(Number.NaN)).toBe(FANOUT_DEFAULT);
		});
	});

	describe("buildVariants", () => {
		test("不含主回答；去空、去重、按 fanout-1 封顶", () => {
			expect(buildVariants("主回答", ["备选一", "备选二"], 3)).toEqual([
				"备选一",
				"备选二",
			]);
			// fanout=1（关）永远没有备选
			expect(buildVariants("主回答", ["备选一"], 1)).toEqual([]);
			// 空串与与主回答相同的 shadow 被丢弃；重复只留一次
			expect(buildVariants("主", ["", "  ", "主", "备", "备"], 3)).toEqual([
				"备",
			]);
			// cap: fanout=2 只留 1 条
			expect(buildVariants("主", ["a", "b", "c"], 2)).toEqual(["a"]);
		});
	});
});
