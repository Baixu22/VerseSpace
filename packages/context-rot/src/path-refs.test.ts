import { describe, expect, test } from "bun:test";
import { extractRefs, normalizeRef } from "./path-refs";

describe("extractRefs", () => {
	test("inline backticks that look like paths are citations", () => {
		const refs = extractRefs(
			"see `src/keep.ts` and `packages/workbench/src/cli.ts` please",
		);
		expect(refs.map((item) => item.ref)).toEqual([
			"src/keep.ts",
			"packages/workbench/src/cli.ts",
		]);
	});

	test("placeholder paths (foo/bar/baz) are examples, not citations", () => {
		// issue #2: `foo.rs` / `src/foo.test.ts` / `foo/mod.rs` / `foo/` on the
		// helmor AGENTS.md were counted as stale assertions — they are teaching
		// placeholders and buried the real signal.
		const refs = extractRefs(
			"convert `foo.rs` to `foo/mod.rs`, split `foo.tsx` into `foo/`, test `src/foo.test.ts`, but keep `src/barrel.ts`",
		);
		expect(refs.map((item) => item.ref)).toEqual(["src/barrel.ts"]);
	});

	test("a basename with a source extension counts; a bare identifier does not", () => {
		const refs = extractRefs("call `runDoctor` then open `queue.ts`");
		expect(refs.map((item) => item.ref)).toEqual(["queue.ts"]);
		expect(refs[0]?.kind).toBe("file");
	});

	test("fenced examples are not citations", () => {
		const refs = extractRefs(
			["prose `src/keep.ts`", "```ts", "import './src/example.ts'", "```"].join(
				"\n",
			),
		);
		expect(refs.map((item) => item.ref)).toEqual(["src/keep.ts"]);
	});

	test("markdown links to relative files count", () => {
		const refs = extractRefs("see [the cli](packages/workbench/src/cli.ts)");
		expect(refs.map((item) => item.ref)).toEqual([
			"packages/workbench/src/cli.ts",
		]);
	});

	test("http links and npm scopes are ignored", () => {
		const refs = extractRefs(
			"read [`docs`](https://example.com/x) and `@scope/pkg` and `src/real.ts`",
		);
		expect(refs.map((item) => item.ref)).toEqual(["src/real.ts"]);
	});

	test("duplicates collapse to the first line", () => {
		const refs = extractRefs("`src/a.ts`\n\nlater `src/a.ts` again");
		expect(refs).toHaveLength(1);
		expect(refs[0]?.line).toBe(1);
	});
});

describe("normalizeRef", () => {
	test("strips ./, backslashes, wrapping quotes, trailing punctuation", () => {
		expect(normalizeRef("./src\\\\foo.ts.")).toBe("src/foo.ts");
		expect(normalizeRef("'src/foo.ts'")).toBe("src/foo.ts");
	});

	test("URLs are rejected before the slash collapse can disguise them", () => {
		// 曾经的缺陷：`https://github.com/x.git` 先被 `/\/+/ → /` 折成
		// `https:/github.com/x.git`，于是 `startsWith("https://")` 与
		// `includes("://")` 两条判断都不成立，它被当成仓库相对路径报成 stale。
		// AGENTS.md 的 remote 表因此贡献了两条误报。
		expect(
			normalizeRef("https://github.com/Baixu22/VerseSpace.git"),
		).toBeNull();
		expect(normalizeRef("https://jihulab.com")).toBeNull();
		expect(normalizeRef("http://example.com/a.ts")).toBeNull();
		expect(normalizeRef("ssh://git@host/x.git")).toBeNull();
	});

	test("scp-style git remotes are not paths", () => {
		expect(normalizeRef("git@jihulab.com:Baixu22/VerseSpace.git")).toBeNull();
		expect(normalizeRef("git@github.com:owner/repo.git")).toBeNull();
	});

	test("the new rejections do not swallow real relative paths", () => {
		expect(normalizeRef("packages/workbench/src/cli.ts")).toBe(
			"packages/workbench/src/cli.ts",
		);
		expect(normalizeRef("src/a.ts")).toBe("src/a.ts");
		expect(normalizeRef("docs/decisions/README.md")).toBe(
			"docs/decisions/README.md",
		);
	});
});
