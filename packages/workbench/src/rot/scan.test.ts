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
			"src/placeholder.ts": "export {};\n",
		});
		try {
			const report = await runContextRot(root);
			expect(report).toMatchObject({ assertions: 0, stale: 0, sources: [] });
			expect(formatRotHeadline(report)).toContain("没有可核对");
		} finally {
			await cleanup();
		}
	});

	test("a gitignored citation is generated, not stale (issue #2)", async () => {
		const { root, cleanup } = await makeTree({
			"AGENTS.md":
				"built to `sidecar/dist/helmor-sidecar`, cache at `sidecar/.bundle-cache`, source in `src/real.ts`, gone `src/gone.ts`",
			".gitignore": "sidecar/dist/\nsidecar/.bundle-cache/\n",
			"src/real.ts": "export {};\n",
			// the cache dir exists on disk (git never indexes it)
			"sidecar/.bundle-cache/keep.txt": "cached\n",
		});
		try {
			// the index must come from git (ls-files) for check-ignore to agree
			// with it: seed a repo with the tracked files
			const init = Bun.spawnSync(["git", "init", "-q"], { cwd: root });
			expect(init.exitCode).toBe(0);
			Bun.spawnSync(["git", "add", "AGENTS.md", ".gitignore", "src/real.ts"], {
				cwd: root,
			});
			const report = await runContextRot(root);
			const byRef = new Map(report.findings.map((item) => [item.ref, item]));
			// exists on disk even though git ignores it: the citation is live
			expect(byRef.get("sidecar/.bundle-cache")?.stale).toBe(false);
			expect(byRef.get("sidecar/.bundle-cache")?.generated).toBe(false);
			// covered by .gitignore and not on disk (unbuilt output):
			// unverifiable from the index, counted as generated — never stale
			expect(byRef.get("sidecar/dist/helmor-sidecar")?.generated).toBe(true);
			expect(byRef.get("sidecar/dist/helmor-sidecar")?.stale).toBe(false);
			expect(report.stale).toBe(1); // only src/gone.ts is real rot
			expect(report.generated).toBe(1);
			expect(formatRotHeadline(report)).toContain("1 条已失效");
			expect(formatRotHeadline(report)).toContain("另有 1 条生成物引用不计入");
		} finally {
			await cleanup();
		}
	}, 30_000);
});
