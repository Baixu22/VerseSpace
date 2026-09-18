import { describe, expect, test } from "bun:test";
import type { StoredPart, ToolCallPart } from "./thread-types";
import {
	buildGroupSummary,
	collapseParts,
	flattenToolParts,
} from "./tool-collapse";

const tool = (
	toolCallId: string,
	toolName: string,
	args: unknown,
	result?: unknown,
): ToolCallPart => ({
	type: "tool-call",
	toolCallId,
	toolName,
	args,
	...(result === undefined ? {} : { result }),
});

describe("tool collapse", () => {
	test("empty, shell and mixed summaries preserve counts", () => {
		expect(collapseParts([], { streaming: true })).toEqual([]);
		const tools = [
			tool("sh1", "Bash", { command: "ls" }),
			tool("sh2", "Bash", { command: "git status" }),
			tool("r", "Read", { path: "a" }),
		];
		expect(buildGroupSummary(tools, false)).toBe(
			"读取 1 个文件，运行 2 条只读命令",
		);
		expect(collapseParts(tools, { streaming: false })[0]).toMatchObject({
			category: "mixed",
		});
	});

	test("last result alone controls activity and null is a settled result", () => {
		for (const result of [null, false, "", []]) {
			const parts = [
				tool("r1", "Read", { path: "a" }),
				tool("r2", "Read", { path: "b" }, result),
			];
			expect(collapseParts(parts, { streaming: true })[0]).toMatchObject({
				active: false,
			});
		}
	});

	test("group identity stays stable and snapshots never alias raw facts", () => {
		const raw = [
			tool("a", "Read", { path: "a" }),
			tool("b", "Read", { path: "b" }),
		];
		const before = collapseParts(raw, { streaming: true });
		raw[1]!.result = "settled";
		(raw[0]!.args as { path: string }).path = "changed";
		raw.push(tool("c", "Read", { path: "c" }));
		const after = collapseParts(raw, { streaming: true });
		expect(before[0]).toMatchObject({
			id: "group:a",
			tools: [{ args: { path: "a" } }, { toolCallId: "b" }],
		});
		expect(flattenToolParts(before)[1]?.result).toBeUndefined();
		expect(after[0]).toMatchObject({ id: "group:a" });
		expect(flattenToolParts(after)).toEqual(raw);
		expect(flattenToolParts(undefined)).toEqual([]);
	});

	test("deduplicates complete patterns before truncating and reports unique count", () => {
		const pattern = "a".repeat(50);
		expect(
			buildGroupSummary(
				[
					tool("s1", "Grep", { pattern }),
					tool("s2", "Grep", { pattern }),
					tool("s3", "Grep", { pattern: `${pattern}b` }),
				],
				false,
			),
		).toBe("搜索过 2 个模式（3×）");
	});
	test("deduplicates search patterns and counts distinct read paths", () => {
		const tools = [
			tool("s1", "Grep", { pattern: "needle" }),
			tool("s2", "Search", { query: "needle" }),
			tool("r1", "Read", { file_path: "a.ts" }),
			tool("r2", "Read", { file_path: "a.ts" }),
			tool("r3", "Read", { file_path: "b.ts" }),
		];
		expect(buildGroupSummary(tools, false)).toBe(
			"搜索过 'needle'（2×），读取 2 个文件",
		);
	});

	test("truncates long patterns without splitting surrogate pairs", () => {
		const pattern = `${"汉".repeat(38)}😀suffix`;
		const summary = buildGroupSummary(
			[tool("s1", "Grep", { pattern }), tool("s2", "Grep", { pattern })],
			false,
		);
		expect(summary).not.toContain("�");
		expect(summary).toContain("😀…");
	});

	test("keeps a single tool visible and flushes groups before boundaries", () => {
		const parts: StoredPart[] = [
			tool("one", "Read", { file_path: "one.ts" }, "ok"),
			{ type: "text", text: "between" },
			tool("two", "Glob", { pattern: "*.ts" }, []),
			tool("three", "Read", { file_path: "three.ts" }),
			tool("write", "Edit", { file_path: "out.ts" }),
		];
		const folded = collapseParts(parts, { streaming: true });
		expect(folded.map((part) => part.type)).toEqual([
			"tool-call",
			"text",
			"collapsed-group",
			"tool-call",
		]);
		const group = folded[2];
		expect(group?.type).toBe("collapsed-group");
		if (group?.type === "collapsed-group") {
			expect(group.id).toBe("group:two");
			expect(group.category).toBe("mixed");
			expect(group.active).toBe(true);
		}
	});

	test("final groups are settled and flatten restores every tool fact", () => {
		const raw = [
			tool("r1", "Read", { file_path: "one.ts" }, "one"),
			tool("r2", "Read", { file_path: "two.ts" }),
		];
		const folded = collapseParts(raw, { streaming: false });
		expect(folded).toHaveLength(1);
		expect(folded[0]).toMatchObject({
			type: "collapsed-group",
			active: false,
			summary: "读取 2 个文件",
		});
		expect(flattenToolParts(folded).map((part) => part.toolCallId)).toEqual([
			"r1",
			"r2",
		]);
	});
});
