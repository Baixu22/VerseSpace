import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FileIndex,
	formatRotHeadline,
	isInstructionFile,
	resolveRef,
	runContextRot,
} from "./scan";

async function makeTree(
	files: Record<string, string>,
): Promise<{ root: string; cleanup(): Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "workbench-rot-"));
	for (const [rel, body] of Object.entries(files)) {
		const full = join(root, rel);
		await mkdir(join(full, ".."), { recursive: true });
		await writeFile(full, body, "utf8");
	}
	return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe("instruction file detection", () => {
	test("known agent instruction names and cursor rules count", () => {
		expect(isInstructionFile("AGENTS.md")).toBe(true);
		expect(isInstructionFile("docs/CLAUDE.md")).toBe(true);
		expect(isInstructionFile(".cursor/rules/foo.mdc")).toBe(true);
		expect(isInstructionFile(".github/copilot-instructions.md")).toBe(true);
		expect(isInstructionFile("README.md")).toBe(false);
		expect(isInstructionFile("src/cli.ts")).toBe(false);
	});
});

describe("resolveRef", () => {
	const index: FileIndex = {
		files: new Set(["src/foo.ts", "packages/workbench/src/cli.ts"]),
		dirs: new Set([
			"src",
			"packages",
			"packages/workbench",
			"packages/workbench/src",
		]),
		basenames: new Set(["foo.ts", "cli.ts"]),
	};

	test("a path is live only when the file or its directory exists", () => {
		expect(resolveRef("src/foo.ts", index)).toBe(true);
		expect(resolveRef("packages/workbench/src/cli.ts", index)).toBe(true);
		expect(resolveRef("src", index)).toBe(true);
		expect(resolveRef("src/missing.ts", index)).toBe(false);
	});

	test("a bare filename matches any basename in the tree", () => {
		expect(resolveRef("cli.ts", index)).toBe(true);
		expect(resolveRef("nope.ts", index)).toBe(false);
	});

	test("a suffix citation still holds when the tree has that path deeper", () => {
		const deep: FileIndex = {
			files: new Set(["src/features/panel/index.tsx"]),
			dirs: new Set(["src", "src/features", "src/features/panel"]),
			basenames: new Set(["index.tsx"]),
		};
		expect(resolveRef("features/panel/", deep)).toBe(true);
		expect(resolveRef("features/missing/", deep)).toBe(false);
		expect(resolveRef("panel/", deep)).toBe(true);
		expect(resolveRef("panel", deep)).toBe(false);
	});
});

describe("runContextRot", () => {
	test("counts unique citations and reports how many are gone", async () => {
		const { root, cleanup } = await makeTree({
			"AGENTS.md": [
				"# rules",
				"read `src/keep.ts` and also `src/gone.ts`",
				"again `src/keep.ts`",
			].join("\n"),
			"src/keep.ts": "export const keep = 1;\n",
		});
		try {
			const report = await runContextRot(root);
			expect(report.assertions).toBe(2);
			expect(report.stale).toBe(1);
			expect(report.sources).toEqual(["AGENTS.md"]);
			const gone = report.findings.find((item) => item.ref === "src/gone.ts");
			expect(gone?.stale).toBe(true);
			expect(gone?.source).toBe("AGENTS.md");
			expect(formatRotHeadline(report)).toContain("2 条架构断言");
			expect(formatRotHeadline(report)).toContain("1 条已失效");
		} finally {
			await cleanup();
		}
	});

	test("a tree with no instruction files is a zero, not an error", async () => {
		const { root, cleanup } = await makeTree({
			"src/foo.ts": "export {};\n",
		});
		try {
			const report = await runContextRot(root);
			expect(report).toMatchObject({ assertions: 0, stale: 0, sources: [] });
			expect(formatRotHeadline(report)).toContain("没有可核对");
		} finally {
			await cleanup();
		}
	});
});
