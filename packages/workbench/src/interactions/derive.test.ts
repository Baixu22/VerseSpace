/**
 * PROV → 交互事件派生测试：used→selection、generated→edit、
 * span→delta、目录判定、多路径多事件、origin 分组。
 */

import { describe, expect, test } from "bun:test";
import type { FootprintEntry } from "../blackboard/sessions";
import { contentTypeOf, deltaOfSelection, deriveInteractions } from "./derive";

function entry(overrides: Partial<FootprintEntry> = {}): FootprintEntry {
	return {
		timestamp: "2026-08-31T10:00:00.000Z",
		activity: "act-1",
		agent: "ws-a",
		used: [],
		generated: [],
		...overrides,
	};
}

describe("deriveInteractions", () => {
	test("used → selection（读是触碰不是改动）", () => {
		const events = deriveInteractions(
			entry({ used: [{ path: "src/a.ts", version: null }] }),
			"ws-a",
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			kind: "selection",
			origin: "ws-a",
			handle: "src/a.ts",
			contentType: "file",
			time: "2026-08-31T10:00:00.000Z",
		});
	});

	test("generated → edit（改动是更强的信号）", () => {
		const events = deriveInteractions(
			entry({ generated: [{ path: "src/b.ts", version: "h" }] }),
			"ws-a",
		);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ kind: "edit", handle: "src/b.ts" });
	});

	test("selection 的 delta 取读取范围行数（span），无 span 为 0", () => {
		expect(
			deriveInteractions(
				entry({
					used: [{ path: "a.ts", version: null, span: { start: 10, end: 15 } }],
				}),
				"w",
			)[0]?.delta,
		).toBe(6);
		expect(
			deriveInteractions(
				entry({ used: [{ path: "a.ts", version: null }] }),
				"w",
			)[0]?.delta,
		).toBe(0);
	});

	test("edit 的 delta 按一次改动计（工具调用不知行数变化）", () => {
		expect(
			deriveInteractions(
				entry({ generated: [{ path: "a.ts", version: "h" }] }),
				"w",
			)[0]?.delta,
		).toBe(1);
	});

	test("无扩展名路径按目录计 contentType", () => {
		expect(contentTypeOf("src/")).toBe("directory");
		expect(contentTypeOf("src")).toBe("directory");
		expect(contentTypeOf("src/a.ts")).toBe("file");
		expect(contentTypeOf(".cursor/rules/x.mdc")).toBe("file");
	});

	test("used 与 generated 混合时按序派发", () => {
		const events = deriveInteractions(
			entry({
				used: [{ path: "a.ts", version: null }],
				generated: [{ path: "b.ts", version: "h" }],
			}),
			"ws-a",
		);
		expect(events.map((e) => e.kind)).toEqual(["selection", "edit"]);
		expect(events.every((e) => e.origin === "ws-a")).toBe(true);
	});

	test("空活动不派生事件", () => {
		expect(deriveInteractions(entry(), "ws-a")).toHaveLength(0);
	});
});

describe("deltaOfSelection", () => {
	test("span 越界钳制在合理范围", () => {
		expect(
			deltaOfSelection({
				path: "a.ts",
				version: null,
				span: { start: 0, end: 0 },
			}),
		).toBe(1);
		expect(
			deltaOfSelection({
				path: "a.ts",
				version: null,
				span: { start: 3, end: 2 },
			}),
		).toBe(1);
	});
});
