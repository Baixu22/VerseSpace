import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { extractFootprint, hashPathClaim } from "./footprint";

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

describe("hashPathClaim 路径身份归一（2026-09-06 真进程 E2E 抓到的跨写者缺陷）", () => {
	test("projectRoot 内的绝对路径落账为项目相对，与 git 钩子的相对路径同身份", async () => {
		const root = await mkdtemp(join(tmpdir(), "fp-"));
		try {
			const abs = join(root, "src", "a.ts");
			await mkdir(dirname(abs), { recursive: true });
			await writeFile(abs, "export const a = 1;\n", "utf8");
			const fromAbsolute = await hashPathClaim(root, abs);
			const fromRelative = await hashPathClaim(root, "src/a.ts");
			expect(fromAbsolute.path).toBe("src/a.ts");
			expect(fromRelative.path).toBe("src/a.ts");
			expect(fromAbsolute.version).toBe(fromRelative.version);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("projectRoot 之外的绝对路径保持原样，不捏造相对身份", async () => {
		const root = await mkdtemp(join(tmpdir(), "fp-"));
		const outside = await mkdtemp(join(tmpdir(), "fp-out-"));
		try {
			const claim = await hashPathClaim(root, outside);
			expect(claim.path).toBe(outside.replace(/\\/g, "/"));
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});
});
