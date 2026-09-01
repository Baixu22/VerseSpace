import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeRef } from "./extract.ts";
import { buildCorpus, verifyRef } from "./verify.ts";

function makeRef(
	partial: Pick<CodeRef, "kind" | "text"> & Partial<CodeRef>,
): CodeRef {
	return {
		raw: partial.text,
		doc: "AGENTS.md",
		line: 1,
		...partial,
	} as CodeRef;
}

function withFixture(fn: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "context-rot-test-"));
	try {
		fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true, maxRetries: 5 });
	}
}

describe("verifyRef", () => {
	test("path：存在的文件有效，不存在的失效", () => {
		withFixture((root) => {
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
			const corpus = buildCorpus(root, []);
			expect(
				verifyRef(makeRef({ kind: "path", text: "src/a.ts" }), root, corpus)
					.status,
			).toBe("valid");
			expect(
				verifyRef(
					makeRef({ kind: "path", text: "src/missing.ts" }),
					root,
					corpus,
				),
			).toEqual({
				status: "stale",
				reason: "路径不存在",
			});
			expect(
				verifyRef(makeRef({ kind: "path", text: "src" }), root, corpus).status,
			).toBe("valid");
		});
	});

	test("package：在 package.json 依赖里声明即有效", () => {
		withFixture((root) => {
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({ name: "demo", dependencies: { zod: "^4.0.0" } }),
			);
			const corpus = buildCorpus(root, []);
			expect(
				verifyRef(makeRef({ kind: "package", text: "zod" }), root, corpus)
					.status,
			).toBe("valid");
			expect(
				verifyRef(
					makeRef({ kind: "package", text: "@nope/missing" }),
					root,
					corpus,
				),
			).toEqual({
				status: "stale",
				reason: "未在任何 package.json 声明",
			});
		});
	});

	test("symbol：全词匹配命中即有效，0 次出现即失效", () => {
		withFixture((root) => {
			mkdirSync(join(root, "src"), { recursive: true });
			writeFileSync(
				join(root, "src", "lib.ts"),
				"export function useAppShellState() {}\nexport const notUseAppShellStateX = 1;\n",
			);
			const corpus = buildCorpus(root, []);
			expect(
				verifyRef(
					makeRef({ kind: "symbol", text: "useAppShellState" }),
					root,
					corpus,
				).status,
			).toBe("valid");
			expect(
				verifyRef(
					makeRef({ kind: "symbol", text: "useAppShellStat" }),
					root,
					corpus,
				),
			).toEqual({
				status: "stale",
				reason: "全库 0 次出现",
			});
		});
	});

	test("symbol：指引文件自身不参与验证（避免自我背书）", () => {
		withFixture((root) => {
			writeFileSync(join(root, "AGENTS.md"), "mentions `GhostSymbol` here\n");
			const corpus = buildCorpus(root, ["AGENTS.md"]);
			expect(
				verifyRef(
					makeRef({ kind: "symbol", text: "GhostSymbol" }),
					root,
					corpus,
				),
			).toEqual({
				status: "stale",
				reason: "全库 0 次出现",
			});
		});
	});

	test("path：后缀匹配——文档缩写路径按基路径相对处理", () => {
		withFixture((root) => {
			mkdirSync(join(root, "src", "nested", "deep"), { recursive: true });
			writeFileSync(
				join(root, "src", "nested", "deep", "file.ts"),
				"export const x = 1;\n",
			);
			const corpus = buildCorpus(root, []);
			expect(
				verifyRef(makeRef({ kind: "path", text: "deep/file.ts" }), root, corpus)
					.status,
			).toBe("valid");
			expect(
				verifyRef(makeRef({ kind: "path", text: "file.ts" }), root, corpus)
					.status,
			).toBe("valid");
			expect(
				verifyRef(makeRef({ kind: "path", text: "nested" }), root, corpus)
					.status,
			).toBe("valid");
		});
	});

	test("path：无扩展名目录找不到时降级为 unverified，不误报失效", () => {
		withFixture((root) => {
			writeFileSync(join(root, "a.ts"), "const a = 1;\n");
			const corpus = buildCorpus(root, []);
			expect(
				verifyRef(makeRef({ kind: "path", text: "nowhere" }), root, corpus),
			).toEqual({
				status: "unverified",
			});
			expect(
				verifyRef(
					makeRef({ kind: "path", text: "missing-file.ts" }),
					root,
					corpus,
				),
			).toEqual({
				status: "stale",
				reason: "路径不存在",
			});
		});
	});

	test("buildCorpus：跳过 node_modules 与 dist", () => {
		withFixture((root) => {
			mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
			writeFileSync(
				join(root, "node_modules", "pkg", "index.js"),
				"HiddenInDeps\n",
			);
			mkdirSync(join(root, "dist"), { recursive: true });
			writeFileSync(join(root, "dist", "cli.js"), "HiddenInDist\n");
			writeFileSync(join(root, "src.ts"), "VisibleSymbol\n");
			const corpus = buildCorpus(root, []);
			expect(corpus.sourceFiles).toHaveLength(1);
		});
	});
});
