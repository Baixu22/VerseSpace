import { describe, expect, test } from "bun:test";
import { extractFootprint } from "./footprint";

describe("extractFootprint (stream-json → footprint)", () => {
	test("Read tool_use yields a used claim", () => {
		const fp = extractFootprint(
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "toolu-1",
							name: "Read",
							input: { file_path: "D:\\proj\\src\\a.ts" },
						},
					],
				},
			},
			"t-session",
		);
		expect(fp?.activity).toBe("toolu-1");
		expect(fp?.agent).toBe("t-session");
		expect(fp?.used).toEqual([{ path: "D:\\proj\\src\\a.ts", version: null }]);
		expect(fp?.generated).toEqual([]);
		expect(fp?.facets.tool).toBe("Read");
	});

	test("Write tool_use yields a generated claim", () => {
		const fp = extractFootprint(
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "toolu-2",
							name: "Write",
							input: { file_path: "D:/proj/src/b.ts", content: "x" },
						},
					],
				},
			},
			"t-session",
		);
		expect(fp?.generated).toEqual([
			{ path: "D:/proj/src/b.ts", version: null },
		]);
	});

	test("subagent activity is attributed via parent_tool_use_id", () => {
		const fp = extractFootprint(
			{
				type: "assistant",
				parent_tool_use_id: "toolu-parent",
				message: {
					content: [
						{
							type: "tool_use",
							id: "toolu-3",
							name: "Edit",
							input: { file_path: "D:/proj/src/c.ts" },
						},
					],
				},
			},
			"t-session",
		);
		expect(fp?.agent).toBe("toolu-parent");
	});

	test("Bash reads are extracted from cat commands", () => {
		const fp = extractFootprint(
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "toolu-4",
							name: "Bash",
							input: {
								command: "cat src/a.ts && cat -n src/b.ts | head -5",
							},
						},
					],
				},
			},
			"t-session",
		);
		expect(fp?.used.map((u) => u.path)).toEqual(["src/a.ts", "src/b.ts"]);
		expect(fp?.facets.command).toContain("cat");
	});

	test("non-file tools and non-tool events yield null", () => {
		expect(
			extractFootprint(
				{
					type: "assistant",
					message: {
						content: [
							{ type: "tool_use", id: "t5", name: "WebSearch", input: {} },
						],
					},
				},
				"t",
			),
		).toBeNull();
		expect(
			extractFootprint({ type: "system", subtype: "init" }, "t"),
		).toBeNull();
	});
});
