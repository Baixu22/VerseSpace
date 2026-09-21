import { describe, expect, test } from "bun:test";
import { noticeParts } from "./notice-parts";

describe("noticeParts", () => {
	test("首行作 label，其余作 body", () => {
		const parts = noticeParts([
			"前提失效：2 个文件。\n\n- src/a.ts\n  观察版本 1 → 当前版本 2\n- src/b.ts\n  观察版本 3 → 当前版本 4",
		]);
		expect(parts).toEqual([
			{
				type: "notice",
				severity: "warning",
				label: "前提失效：2 个文件。",
				body: "- src/a.ts\n  观察版本 1 → 当前版本 2\n- src/b.ts\n  观察版本 3 → 当前版本 4",
			},
		]);
	});

	test("单行通知没有 body 字段", () => {
		expect(
			noticeParts(["前提失效：3 个文件；详情未展开，事件仍保留。"]),
		).toEqual([
			{
				type: "notice",
				severity: "warning",
				label: "前提失效：3 个文件；详情未展开，事件仍保留。",
			},
		]);
	});

	test("空白通知被跳过，顺序保持", () => {
		const parts = noticeParts(["  ", "A\nx", "", "B"]);
		expect(parts.map((p) => p.label)).toEqual(["A", "B"]);
	});
});
